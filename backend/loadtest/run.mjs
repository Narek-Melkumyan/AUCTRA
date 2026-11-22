#!/usr/bin/env node
/**
 * AUCTRA concurrency & load harness.
 *
 *   LOAD_DATABASE_URL=postgresql://…/auctra_load LOAD_REDIS_URL=redis://localhost:6390 \
 *     node loadtest/run.mjs A B C D E F G [--viewers 100,1000,5000,10000] [--out results.json]
 *
 * It builds nothing: run `npm run build` first. The harness starts its own API
 * instances from dist/main.js (production mode) on ports 4101/4102 against the LOAD
 * database and a dedicated Redis, so it can kill and restart them for failure tests.
 */
import { spawn, fork, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bid, countBy, env, latency, makeAuction, makeUsers, pool, sampler, sleep } from './lib.mjs';
import { checkAll, checkAuction } from './verify.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const scenarios = args.filter((a, i) => /^[A-G]$/.test(a) && !args[i - 1]?.startsWith('--'));
const REDIS_URL = env.LOAD_REDIS_URL ?? 'redis://localhost:6390';
const REDIS_PORT = new URL(REDIS_URL).port || '6379';
const POOL_MAX = flag('pool', env.LOAD_POOL_MAX ?? '10');
const METRICS_TOKEN = 'loadtest-metrics-token-0123456789abcdef';
const results = { startedAt: new Date().toISOString(), node: process.version, poolMax: Number(POOL_MAX), scenarios: {} };
const db = pool(8);
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

// ───────────── API instances ─────────────

const instances = new Map();
async function startInstance(port, extra = {}) {
  const proc = spawn(process.execPath, ['dist/main.js'], {
    cwd: root,
    env: {
      ...process.env,
      ...env,
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      IP_HASH_SALT: env.IP_HASH_SALT || 'loadtest-ip-salt',
      EMAIL_PROVIDER: 'disabled',
      PORT: String(port),
      DATABASE_URL: env.LOAD_DATABASE_URL,
      DATABASE_POOL_MAX: POOL_MAX,
      REDIS_URL,
      OPENAI_API_KEY: '',
      METRICS_TOKEN,
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', (d) => (output = (output + d).slice(-20_000)));
  proc.stderr.on('data', (d) => (output = (output + d).slice(-20_000)));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`instance ${port} exited:\n${output}`);
    try {
      if ((await fetch(`${url}/api/health/live`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`instance ${port} did not start:\n${output}`);
    await sleep(200);
  }
  const inst = { port, url, proc, pid: proc.pid, logs: () => output };
  instances.set(port, inst);
  return inst;
}
async function stopInstance(port, signal = 'SIGTERM') {
  const inst = instances.get(port);
  if (!inst) return;
  instances.delete(port);
  inst.proc.kill(signal);
  await new Promise((r) => (inst.proc.exitCode !== null ? r() : inst.proc.once('exit', r)));
}
async function stopAll() {
  for (const port of [...instances.keys()]) await stopInstance(port);
}

// ───────────── Viewers (child processes) ─────────────

const viewerGroups = new Set();
async function startViewers(api, total, auctionIds, opts = {}) {
  const perProc = opts.perProc ?? 1250;
  const procs = [];
  for (let offset = 0; offset < total; offset += perProc) {
    const n = Math.min(perProc, total - offset);
    const child = fork(path.join(here, 'viewer-worker.mjs'), [], {
      env: {
        ...process.env,
        VIEWER_API: api,
        VIEWER_COUNT: String(n),
        VIEWER_AUCTIONS: JSON.stringify(auctionIds),
        VIEWER_TOKENS: JSON.stringify(opts.tokens ?? []),
      },
      execArgv: ['--max-old-space-size=2048'],
    });
    procs.push({ child, offset });
  }
  const ask = (p, msg, reply) =>
    new Promise((resolve) => {
      const on = (m) => {
        if (m.cmd === reply) {
          p.child.off('message', on);
          resolve(m);
        }
      };
      p.child.on('message', on);
      p.child.send(msg);
    });
  viewerGroups.add({ kill: () => procs.forEach((p) => p.child.kill('SIGKILL')) });
  const t0 = performance.now();
  const ready = await Promise.all(procs.map((p) => ask(p, { cmd: 'start', offset: p.offset }, 'ready')));
  const all = (msg, reply) => Promise.all(procs.map((p) => ask(p, msg, reply)));
  return {
    joined: ready.reduce((a, r) => a + r.joined, 0),
    joinMs: performance.now() - t0,
    collect: async (keys) => {
      const parts = await all({ cmd: 'collect', keys }, 'collected');
      const out = {};
      for (const k of keys) out[k] = parts.flatMap((p) => p.out[k]);
      const stats = parts.map((p) => p.stats).reduce((a, s) => {
        for (const [k, v] of Object.entries(s)) a[k] = (a[k] ?? 0) + v;
        return a;
      }, {});
      return { out, stats, versions: parts.flatMap((p) => p.versions) };
    },
    reset: () => all({ cmd: 'reset' }, 'reset-ok'),
    disconnect: () => all({ cmd: 'disconnect' }, 'disconnected'),
    reconnect: () => all({ cmd: 'reconnect' }, 'reconnected'),
    versions: () => all({ cmd: 'versions' }, 'versions'),
    stop: () => procs.forEach((p) => p.child.connected && p.child.send({ cmd: 'stop' })),
    kill: () => procs.forEach((p) => p.child.kill('SIGKILL')),
  };
}

/** Scrapes selected Prometheus series from every running instance. */
async function scrapeMetrics() {
  const out = {};
  for (const inst of instances.values()) {
    try {
      const text = await (await fetch(`${inst.url}/api/metrics`, { headers: { Authorization: `Bearer ${METRICS_TOKEN}` } })).text();
      const pick = {};
      for (const line of text.split('\n')) {
        if (line.startsWith('#')) continue;
        if (/^auctra_(bid_duration_seconds_(sum|count)|bid_lock_wait_seconds_(sum|count)|bid_requests_total|db_pool_connections|outbox_lag_seconds_(sum|count)|socket_connections|process_cpu_seconds_total|process_resident_memory_bytes|nodejs_eventloop_lag_p99_seconds)/.test(line)) {
          const i = line.lastIndexOf(' ');
          pick[line.slice(0, i)] = Number(line.slice(i + 1));
        } else if (/^auctra_http_request_duration_seconds_(sum|count)\{[^}]*route="\/api\/auctions\/:id\/bids"/.test(line)) {
          const i = line.lastIndexOf(' ');
          pick[line.slice(0, i)] = Number(line.slice(i + 1));
        }
      }
      out[inst.port] = pick;
    } catch (err) {
      out[inst.port] = { error: String(err) };
    }
  }
  return out;
}

// ───────────── Helpers ─────────────

const dollars = (d) => BigInt(Math.round(d * 100));
async function seller() {
  return (await makeUsers(db, 1, 'ls'))[0];
}
async function auctionVersion(id) {
  return (await db.query(`SELECT version FROM auctions WHERE id = $1`, [id])).rows[0].version;
}
function summarize(rs, wallMs) {
  return {
    requests: rs.length,
    byStatus: countBy(rs, (r) => r.status),
    byCode: countBy(rs, (r) => r.code),
    // Deliberate, retryable back-pressure (bounded queue / lock wait) — not failures.
    shedRetryable: rs.filter((r) => r.status === 503 && ['AUCTION_BUSY', 'BID_SYSTEM_BUSY'].includes(r.code)).length,
    serverErrors: rs.filter(
      (r) => r.status === 0 || (r.status >= 500 && !(r.status === 503 && ['AUCTION_BUSY', 'BID_SYSTEM_BUSY'].includes(r.code))),
    ).length,
    throughputRps: Math.round((rs.length / wallMs) * 1000 * 10) / 10,
    latencyMs: latency(rs.map((r) => r.ms)),
  };
}
const fail = (scenario, msg) => {
  results.scenarios[scenario].failures ??= [];
  results.scenarios[scenario].failures.push(msg);
  log(`  ✗ ${msg}`);
};

// ───────────── Scenarios ─────────────

/** A — two users bid the same amount at the same instant, 25 times on fresh auctions. */
async function A(api) {
  const s = await seller();
  const out = (results.scenarios.A = { rounds: 25 });
  const all = [];
  const ids = [];
  for (let r = 0; r < 25; r++) {
    const [u1, u2] = await makeUsers(db, 2);
    const id = await makeAuction(db, s.id, { start: dollars(45_000) });
    ids.push(id);
    const rs = await Promise.all([bid(api, u1, id, dollars(45_000)), bid(api, u2, id, dollars(45_000))]);
    all.push(...rs);
    const ok = rs.filter((x) => x.status === 201);
    if (ok.length !== 1) fail('A', `round ${r}: ${ok.length} accepted`);
    const loser = rs.find((x) => x.status !== 201);
    if (loser && loser.code !== 'BID_TOO_LOW') fail('A', `round ${r}: loser got ${loser.code}`);
  }
  Object.assign(out, summarize(all, 1), { invariantViolations: await checkAll(db, ids) });
}

/** B — 10 bidders around $45k, each request sent 3× concurrently with one idempotency key. */
async function B(api) {
  const s = await seller();
  const [opener, ...users] = await makeUsers(db, 11);
  const id = await makeAuction(db, s.id, { start: dollars(45_000), increment: dollars(250) });
  await bid(api, opener, id, dollars(45_000));
  const amounts = [45_500, 46_000, 45_750, 47_000, 45_250, 46_500, 48_000, 45_300, 46_250, 47_500];
  const reqs = users.map((u, i) => ({ u, amount: dollars(amounts[i]), key: randomUUID() }));
  const t0 = performance.now();
  const rs = await Promise.all(reqs.flatMap((r) => [0, 1, 2].map(() => bid(api, r.u, id, r.amount, r.key))));
  const wall = performance.now() - t0;
  const out = (results.scenarios.B = summarize(rs, wall));
  // Every copy of one logical request must get the same outcome / bid id.
  for (const r of reqs) {
    const copies = rs.filter((x) => x.key === r.key);
    const ids = new Set(copies.filter((c) => c.status < 300).map((c) => c.body.bid.id));
    if (ids.size > 1) fail('B', `key ${r.key} produced ${ids.size} bids`);
    const statuses = new Set(copies.map((c) => (c.status < 300 ? 'ok' : c.code)));
    if (statuses.size > 1) fail('B', `key ${r.key} inconsistent outcomes ${[...statuses]}`);
  }
  // Same key, different amount → IDEMPOTENCY_KEY_REUSED (or the original rejection).
  const accepted = rs.find((x) => x.status === 201);
  if (accepted) {
    const owner = reqs.find((r) => r.key === accepted.key);
    const reuse = await bid(api, owner.u, id, owner.amount + dollars(1_000), owner.key);
    out.keyReuse = reuse.code;
    if (reuse.code !== 'IDEMPOTENCY_KEY_REUSED') fail('B', `key reuse returned ${reuse.code}`);
  }
  const bids = (await db.query(`SELECT sequence, "amountCents" FROM bids WHERE "auctionId" = $1 ORDER BY sequence`, [id])).rows;
  out.acceptedOrder = bids.map((b) => `#${b.sequence} $${Number(b.amountCents) / 100}`);
  out.replays = rs.filter((x) => x.status === 200).length;
  out.invariantViolations = await checkAll(db, [id]);
}

/** C — 100 bidders, 100 attempts in one burst (+10 concurrent duplicate retries). */
async function C(api) {
  const label = 'C';
  const s = await seller();
  const burst = Number(flag('cburst', '100'));
  const users = await makeUsers(db, burst);
  const id = await makeAuction(db, s.id, { start: dollars(45_000), increment: dollars(250) });
  const reqs = users.map((u) => ({ u, amount: dollars(45_000 + 250 * Math.floor(Math.random() * 60)), key: randomUUID() }));
  const sends = [...reqs, ...reqs.slice(0, Math.ceil(burst / 10))]; // concurrent retries of the same logical requests
  const t0 = performance.now();
  const rs = await Promise.all(sends.map((r) => bid(api, r.u, id, r.amount, r.key)));
  const wall = performance.now() - t0;
  const out = (results.scenarios[label] = { ...summarize(rs, wall), wallMs: Math.round(wall) });
  const accepted201 = new Set(rs.filter((r) => r.status === 201).map((r) => r.body.bid.id));
  out.acceptedBids = accepted201.size;
  out.burst = burst;
  const expected = new Set(['OK', 'BID_TOO_LOW', 'ALREADY_HIGHEST_BIDDER', 'AUCTION_BUSY']);
  out.unexpected = rs.filter((r) => !expected.has(r.code)).map((r) => r.code);
  if (out.serverErrors) fail(label, `${out.serverErrors} server errors / network failures`);
  out.invariantViolations = await checkAll(db, [id]);
  const v = await checkAuction(db, id, { expectedAccepted: accepted201.size });
  if (v.length) fail(label, v.join('; '));
  return { id, users };
}

/** D — 50 live auctions × 10 bidders for `secs`, then the same with a hot auction bursting. */
async function D(api, api2) {
  const s = await seller();
  const secs = Number(flag('dsecs', '20'));
  const auctions = [];
  for (let i = 0; i < 50; i++) auctions.push(await makeAuction(db, s.id, { start: dollars(1_000), increment: dollars(10) }));
  const bidders = await makeUsers(db, 500);
  const out = (results.scenarios.D = {});
  const runPhase = async (name, withHot) => {
    const rs = [];
    let stop = false;
    const loops = bidders.map(async (u, i) => {
      const id = auctions[i % 50];
      let next = dollars(1_000);
      await sleep(Math.random() * 2500);
      while (!stop) {
        const r = await bid(i % 2 && api2 ? api2 : api, u, id, next);
        rs.push(r);
        if (r.status === 201) next = BigInt(r.body.auction.minimumNextBid.minor);
        else if (r.body?.details?.minimum) next = BigInt(r.body.details.minimum.minor);
        await sleep(2500 + Math.random() * 500); // stay under the 30 bids/min per-user limit
      }
    });
    let hot;
    const hotRs = [];
    if (withHot) {
      const hotUsers = await makeUsers(db, 100);
      hot = await makeAuction(db, s.id, { start: dollars(45_000), increment: dollars(250) });
      (async () => {
        let k = 0;
        while (!stop) {
          const burst = await Promise.all(
            hotUsers.map((u) => bid(api, u, hot, dollars(45_000 + 250 * (k * 100 + Math.floor(Math.random() * 100))))),
          );
          hotRs.push(...burst);
          k++;
          await sleep(3000);
        }
      })();
    }
    const t0 = performance.now();
    await sleep(secs * 1000);
    stop = true;
    await Promise.all(loops);
    const wall = performance.now() - t0;
    out[name] = { ...summarize(rs, wall), ...(withHot ? { hot: summarize(hotRs, wall) } : {}) };
    return hot;
  };
  log('  D: 50 auctions, steady');
  await runPhase('steady', false);
  log('  D: 50 auctions + hot auction bursting 100 bids every 3s');
  const hot = await runPhase('withHotAuction', true);
  out.invariantViolations = await checkAll(db, [...auctions, hot]);
}

/** Places `n` sequential bids and measures delivery of each event to every viewer. */
async function measureDelivery(api, viewers, id, users, n, startMinor) {
  await viewers.reset();
  const sent = [];
  let amount = startMinor;
  for (let k = 0; k < n; k++) {
    const u = users[k % users.length];
    const t = performance.timeOrigin + performance.now();
    const r = await bid(api, u, id, amount);
    if (r.status !== 201) throw new Error(`bid failed: ${r.code}`);
    sent.push({ t, key: `${id}:${r.body.auction.version}`, httpMs: r.ms });
    amount = BigInt(r.body.auction.minimumNextBid.minor);
    await sleep(400);
  }
  await sleep(2000);
  const { out, stats } = await viewers.collect(sent.map((s) => s.key));
  const lat = [];
  let delivered = 0;
  for (const s of sent) {
    for (const t of out[s.key]) lat.push(t - s.t);
    delivered += out[s.key].length;
  }
  return { events: n, deliveries: delivered, latencyMs: latency(lat), httpMs: latency(sent.map((s) => s.httpMs)), clientStats: stats };
}

/** E — progressive WebSocket viewers in one auction room; fan-out latency per milestone. */
async function E(api) {
  const milestones = flag('viewers', '100,1000,5000,10000').split(',').map(Number);
  const s = await seller();
  const users = await makeUsers(db, 20);
  const out = (results.scenarios.E = {});
  for (const m of milestones) {
    const id = await makeAuction(db, s.id, { start: dollars(1_000), increment: dollars(10) });
    log(`  E: ${m} viewers`);
    const inst = [...instances.values()][0];
    const mon = sampler([inst.pid]);
    const viewers = await startViewers(api, m, [id]);
    const res = await measureDelivery(api, viewers, id, users, 10, dollars(1_000));
    const proc = mon.stop()[inst.pid];
    out[m] = {
      joined: viewers.joined,
      joinWallMs: Math.round(viewers.joinMs),
      ...res,
      expectedDeliveries: m * 10,
      server: proc,
    };
    log(`    joined ${viewers.joined}/${m} in ${Math.round(viewers.joinMs)}ms; delivered ${res.deliveries}/${m * 10}; p95 ${res.latencyMs.p95}ms`);
    viewers.stop();
    await sleep(1500);
    if (viewers.joined < m * 0.99) {
      out[m].note = 'stopped: fewer than 99% of viewers joined';
      break;
    }
  }
}

/** F — viewers on instance 2, bids on instance 1. */
async function F(api, api2) {
  const s = await seller();
  const users = await makeUsers(db, 10);
  const id = await makeAuction(db, s.id, { start: dollars(1_000), increment: dollars(10) });
  const viewers = await startViewers(api2, 500, [id]);
  const res = await measureDelivery(api, viewers, id, users, 10, dollars(1_000));
  const v = await auctionVersion(id);
  const { versions } = await viewers.collect([]);
  const behind = versions.filter((x) => x !== v).length;
  results.scenarios.F = { viewersOnInstance2: viewers.joined, ...res, dbVersion: v, viewersBehind: behind };
  if (res.deliveries !== viewers.joined * 10) fail('F', `delivered ${res.deliveries}/${viewers.joined * 10}`);
  if (behind) fail('F', `${behind} viewers not at DB version`);
  viewers.stop();
}

/** G — failure recovery. */
async function G(api, api2) {
  const out = (results.scenarios.G = {});
  const s = await seller();

  // G1: Redis down during bidding.
  {
    log('  G1: Redis outage');
    const users = await makeUsers(db, 12);
    const id = await makeAuction(db, s.id, { start: dollars(1_000), increment: dollars(10) });
    const viewers = await startViewers(api2, 50, [id]);
    execFileSync('redis-cli', ['-p', REDIS_PORT, 'shutdown', 'nosave']);
    await sleep(500);
    const during = [];
    let amount = dollars(1_000);
    for (let k = 0; k < 5; k++) {
      const r = await bid(api, users[k], id, amount);
      during.push(r);
      if (r.status === 201) amount = BigInt(r.body.auction.minimumNextBid.minor);
    }
    const t0 = performance.now();
    spawn('redis-server', ['--port', REDIS_PORT, '--save', '', '--appendonly', 'no'], { detached: true, stdio: 'ignore' }).unref();
    await sleep(3000); // adapter reconnects
    const after = await bid(api, users[6], id, amount);
    const dbv = await auctionVersion(id);
    let caughtUp = false;
    while (performance.now() - t0 < 20_000) {
      const vs = (await viewers.versions()).flatMap((p) => p.versions);
      if (vs.every((x) => x === dbv)) {
        caughtUp = true;
        break;
      }
      await sleep(200);
    }
    out.redisOutage = {
      bidsDuringOutage: countBy(during, (r) => r.status),
      bidAfterRecovery: after.status,
      viewersCaughtUp: caughtUp,
      recoveryMsFromRedisRestart: Math.round(performance.now() - t0),
      invariantViolations: await checkAll(db, [id]),
    };
    if (during.some((r) => r.status !== 201)) fail('G', 'bids failed while Redis was down');
    if (!caughtUp) fail('G', 'viewers did not catch up after Redis recovery');
    viewers.stop();
  }

  // G2: instance killed mid-burst; failed requests retried on the other instance.
  {
    log('  G2: SIGKILL instance during a 100-bid burst');
    const users = await makeUsers(db, 100);
    const id = await makeAuction(db, s.id, { start: dollars(45_000), increment: dollars(250) });
    const reqs = users.map((u) => ({ u, amount: dollars(45_000 + 250 * Math.floor(Math.random() * 60)), key: randomUUID() }));
    const port = instances.get(4101) ? 4101 : [...instances.keys()][0];
    let answered = 0;
    const burst = Promise.all(
      reqs.map((r) => bid(api, r.u, id, r.amount, r.key).then((x) => (answered++, x))),
    );
    // Kill once some bids have been decided (committed) and others are still in flight.
    const t0 = Date.now();
    while (answered < 10 && Date.now() - t0 < 3000) await sleep(2);
    out.killedAfterResponses = answered;
    await stopInstance(port, 'SIGKILL');
    const first = await burst;
    const lost = first.map((r, i) => ({ r, req: reqs[i] })).filter((x) => x.r.status === 0 || x.r.status >= 500);
    const retried = await Promise.all(lost.map((x) => bid(api2, x.req.u, id, x.req.amount, x.req.key)));
    await startInstance(port);
    // Every request that ever got 201/200 must exist exactly once in the DB.
    const okKeys = [...first, ...retried].filter((r) => r.status === 201 || r.status === 200).map((r) => r.key);
    const inDb = new Set(
      (await db.query(`SELECT "idempotencyKey" FROM bids WHERE "auctionId" = $1`, [id])).rows.map((r) => r.idempotencyKey),
    );
    const missing = okKeys.filter((k) => !inDb.has(k));
    out.instanceKill = {
      firstAttempt: countBy(first, (r) => (r.status === 0 ? 'network' : r.status)),
      retriedOnInstance2: countBy(retried, (r) => (r.status === 200 ? '200 (replayed: committed before crash)' : r.code)),
      acknowledgedButMissing: missing.length,
      invariantViolations: await checkAll(db, [id]),
    };
    if (missing.length) fail('G', `${missing.length} acknowledged bids missing after crash`);
  }

  // G3: viewers disconnect, miss bids, reconnect.
  {
    log('  G3: disconnect / reconnect');
    const users = await makeUsers(db, 6);
    const id = await makeAuction(db, s.id, { start: dollars(1_000), increment: dollars(10) });
    const viewers = await startViewers(api2, 200, [id]);
    await viewers.disconnect();
    let amount = dollars(1_000);
    for (let k = 0; k < 5; k++) {
      const r = await bid(api, users[k], id, amount);
      amount = BigInt(r.body.auction.minimumNextBid.minor);
    }
    const dbv = await auctionVersion(id);
    const rec = await viewers.reconnect();
    const versions = rec.flatMap((p) => p.versions);
    out.reconnect = {
      viewers: versions.length,
      atDbVersionAfterReconnect: versions.filter((v) => v === dbv).length,
      reconnectRecoveryMs: Math.round(Math.max(...rec.map((p) => p.ms))),
    };
    if (versions.some((v) => v !== dbv)) fail('G', 'reconnected viewers behind DB');
    viewers.stop();
  }

  // G4: auction expires during a concurrent stream of bids on both instances; workers on both settle.
  {
    log('  G4: deadline during concurrent bidding');
    const users = await makeUsers(db, 60);
    const id = await makeAuction(db, s.id, { start: dollars(1_000), increment: dollars(10), endsInMs: 1500 });
    const rs = [];
    const t0 = Date.now();
    await Promise.all(
      users.map(async (u, i) => {
        let amount = dollars(1_000 + i * 10);
        while (Date.now() - t0 < 3000) {
          const r = await bid(i % 2 ? api2 : api, u, id, amount);
          rs.push(r);
          if (r.body?.details?.minimum) amount = BigInt(r.body.details.minimum.minor);
          else if (r.status === 201) amount = BigInt(r.body.auction.minimumNextBid.minor);
          if (r.code === 'AUCTION_ENDED') break;
          await sleep(50 + Math.random() * 100);
        }
      }),
    );
    await sleep(3000); // let both workers close + settle
    const a = (await db.query(`SELECT status FROM auctions WHERE id = $1`, [id])).rows[0];
    out.deadline = {
      ...summarize(rs, 3000),
      finalStatus: a.status,
      orders: (await db.query(`SELECT count(*)::int n FROM orders WHERE "auctionId" = $1`, [id])).rows[0].n,
      invariantViolations: await checkAll(db, [id]),
    };
    if (a.status !== 'SOLD') fail('G', `deadline auction ended as ${a.status}`);
  }

  // G5: worker killed while 30 auctions settle; restart and verify exactly-once settlement.
  {
    log('  G5: kill instance while settling 30 auctions');
    const users = await makeUsers(db, 30);
    const ids = [];
    for (let i = 0; i < 30; i++) ids.push(await makeAuction(db, s.id, { start: dollars(1_000), increment: dollars(10), endsInMs: 2500 }));
    await Promise.all(ids.map((id, i) => bid(api2, users[i], id, dollars(1_000))));
    await stopInstance(4102); // only instance 1 runs the worker now
    const port = 4101;
    await sleep(2400);
    await stopInstance(port, 'SIGKILL'); // mid-settlement (likely)
    const settledBefore = (await db.query(`SELECT count(*)::int n FROM auctions WHERE id = ANY($1) AND status IN ('SOLD','UNSOLD')`, [ids])).rows[0].n;
    await startInstance(port);
    await startInstance(4102);
    await sleep(4000);
    const rows = (await db.query(`SELECT status, count(*)::int n FROM auctions WHERE id = ANY($1) GROUP BY status`, [ids])).rows;
    out.settlementRestart = {
      settledBeforeKill: settledBefore,
      afterRestart: Object.fromEntries(rows.map((r) => [r.status, r.n])),
      orders: (await db.query(`SELECT count(*)::int n FROM orders WHERE "auctionId" = ANY($1)`, [ids])).rows[0].n,
      invariantViolations: await checkAll(db, ids),
    };
    if (out.settlementRestart.orders !== 30) fail('G', `expected 30 orders, got ${out.settlementRestart.orders}`);
  }
}

// ───────────── Main ─────────────

const run = { A, B, C, D, E, F, G };
try {
  const i1 = await startInstance(4101);
  const i2 = scenarios.some((s) => 'DFG'.includes(s)) ? await startInstance(4102) : null;
  for (const sc of scenarios) {
    log(`Scenario ${sc}`);
    const mon = sampler([...instances.values()].map((i) => i.pid));
    const t0 = performance.now();
    try {
      await run[sc](i1.url, i2?.url);
    } catch (err) {
      results.scenarios[sc] = { ...(results.scenarios[sc] ?? {}), error: String(err.stack ?? err) };
      log(`  ERROR ${err.message}`);
    }
    // Always reap viewer processes, also after a failed scenario.
    for (const g of viewerGroups) g.kill();
    viewerGroups.clear();
    results.scenarios[sc] = {
      ...(results.scenarios[sc] ?? {}),
      durationMs: Math.round(performance.now() - t0),
      processes: mon.stop(),
      serverMetrics: await scrapeMetrics(),
    };
    console.log(JSON.stringify({ [sc]: results.scenarios[sc] }, null, 1));
  }
} finally {
  await stopAll();
  await db.end();
  const out = flag('out');
  if (out) writeFileSync(out, JSON.stringify(results, null, 2));
}
