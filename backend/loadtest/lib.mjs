/**
 * Shared helpers for the AUCTRA load / concurrency harness.
 *
 * Fixtures (users, sessions, auctions) are inserted directly into the LOAD database so
 * runs are fast and reproducible; every bid, join and event goes through the real HTTP
 * API and Socket.IO server. Access tokens are minted for real session rows with the
 * server's JWT secret, exactly as the server would issue them.
 *
 * Safety: refuses to run unless the database name ends in "_load" or "_test".
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import jwt from 'jsonwebtoken';

const here = path.dirname(fileURLToPath(import.meta.url));

/** backend/.env, then process env overrides (LOAD_DATABASE_URL etc.). */
export function loadEnv() {
  const env = {};
  try {
    for (const line of readFileSync(path.join(here, '..', '.env'), 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m) env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
    }
  } catch {
    /* no .env */
  }
  return { ...env, ...process.env };
}

export const env = loadEnv();

export function dbUrl() {
  const url = env.LOAD_DATABASE_URL;
  if (!url) throw new Error('Set LOAD_DATABASE_URL (a database whose name ends in _load).');
  const name = new URL(url).pathname.slice(1);
  if (!/_(load|test)$/.test(name)) throw new Error(`Refusing to use database "${name}"`);
  return url.replace(/\?.*$/, '');
}

export function pool(max = 5) {
  return new pg.Pool({ connectionString: dbUrl(), max, options: '-c timezone=UTC' });
}

const ARGON_PLACEHOLDER =
  '$argon2id$v=19$m=19456,t=2,p=1$bG9hZHRlc3RzYWx0$0000000000000000000000000000000000000000000';

/** Creates `n` verified users with live sessions; returns { id, handle, token }. */
export async function makeUsers(db, n, prefix = 'lt') {
  const run = randomUUID().slice(0, 6);
  const role = (await db.query(`SELECT id FROM roles WHERE key = 'USER'`)).rows[0].id;
  const users = [];
  const BATCH = 200;
  for (let start = 0; start < n; start += BATCH) {
    const batch = Array.from({ length: Math.min(BATCH, n - start) }, (_, i) => {
      const k = start + i;
      return { id: randomUUID(), sid: randomUUID(), handle: `${prefix}_${run}_${k}`, email: `${prefix}.${run}.${k}@load.auctra` };
    });
    const vals = (rows, fn) => rows.map(fn).join(',');
    await db.query(
      `INSERT INTO users (id, email, "emailVerifiedAt", "passwordHash", "updatedAt") VALUES ${vals(batch, (u, i) => `($${i * 3 + 1}::uuid, $${i * 3 + 2}, now(), $${i * 3 + 3}, now())`)}`,
      batch.flatMap((u) => [u.id, u.email, ARGON_PLACEHOLDER]),
    );
    await db.query(
      `INSERT INTO user_profiles ("userId", "displayName", handle, "updatedAt") VALUES ${vals(batch, (u, i) => `($${i * 2 + 1}::uuid, $${i * 2 + 2}, $${i * 2 + 2}, now())`)}`,
      batch.flatMap((u) => [u.id, u.handle]),
    );
    await db.query(
      `INSERT INTO user_roles ("userId", "roleId") VALUES ${vals(batch, (u, i) => `($${i + 1}::uuid, '${role}')`)}`,
      batch.map((u) => u.id),
    );
    await db.query(
      `INSERT INTO sessions (id, "userId", "userAgent", "expiresAt") VALUES ${vals(batch, (u, i) => `($${i * 2 + 1}::uuid, $${i * 2 + 2}::uuid, 'auctra-loadtest', now() + interval '1 day')`)}`,
      batch.flatMap((u) => [u.sid, u.id]),
    );
    for (const u of batch) users.push({ ...u, token: token(u.id, u.sid) });
  }
  return users;
}

export function token(userId, sessionId) {
  return jwt.sign({ sub: userId, sid: sessionId, typ: 'access' }, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    issuer: 'auctra',
    audience: 'auctra-api',
    expiresIn: 3600,
  });
}

/** Inserts a LIVE auction directly. Prices in minor units. */
export async function makeAuction(db, sellerId, opts = {}) {
  const cat = (await db.query(`SELECT id FROM categories WHERE slug = 'watches'`)).rows[0].id;
  const endsInMs = opts.endsInMs ?? 30 * 60_000;
  const r = await db.query(
    `INSERT INTO auctions ("sellerId", "categoryId", title, description, condition, currency,
       "startingPriceCents", "minIncrementCents", "currentPriceCents", "reservePriceCents",
       "startsAt", "endsAt", "originalEndsAt", status, "updatedAt",
       "antiSnipingEnabled", "antiSnipingWindowSec", "antiSnipingExtensionSec")
     VALUES ($1, $2, $3, 'Load-test lot', 'EXCELLENT', 'USD', $4, $5, NULL, $6,
       now() - interval '1 minute', now() + ($7 || ' milliseconds')::interval,
       now() + ($7 || ' milliseconds')::interval, $8, now(), $9, $10, $11)
     RETURNING id`,
    [
      sellerId,
      cat,
      opts.title ?? `Load lot ${randomUUID().slice(0, 8)}`,
      String(opts.start ?? 4_500_000n),
      String(opts.increment ?? 5_000n),
      opts.reserve === undefined ? null : String(opts.reserve),
      String(endsInMs),
      opts.status ?? 'LIVE',
      opts.antiSniping ?? false,
      opts.antiSnipingWindowSec ?? 0,
      opts.antiSnipingExtensionSec ?? 0,
    ],
  );
  return r.rows[0].id;
}

/** POST a bid; never throws. Returns { status, code, ms, body }. */
export async function bid(api, user, auctionId, amountMinor, key = randomUUID()) {
  const t0 = performance.now();
  try {
    const res = await fetch(`${api}/api/auctions/${auctionId}/bids`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${user.token}`,
        'Idempotency-Key': key,
      },
      body: JSON.stringify({ amountMinor: String(amountMinor) }),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, code: body.code ?? (res.ok ? 'OK' : `HTTP_${res.status}`), ms: performance.now() - t0, body, key };
  } catch (err) {
    return { status: 0, code: `NETWORK:${err.cause?.code ?? err.message}`, ms: performance.now() - t0, body: null, key };
  }
}

export function pct(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

export function latency(values) {
  const r = (v) => (v === null ? null : Math.round(v * 10) / 10);
  return {
    n: values.length,
    p50: r(pct(values, 50)),
    p95: r(pct(values, 95)),
    p99: r(pct(values, 99)),
    max: r(values.length ? Math.max(...values) : null),
  };
}

export function countBy(items, key) {
  const out = {};
  for (const it of items) out[key(it)] = (out[key(it)] ?? 0) + 1;
  return out;
}

/** Samples RSS (MB) and CPU% of processes via `ps` every `everyMs`. */
export function sampler(pids, everyMs = 500) {
  const samples = [];
  const timer = setInterval(() => {
    try {
      const out = execFileSync('ps', ['-o', 'pid=,rss=,%cpu=', '-p', pids.join(',')], { encoding: 'utf8' });
      for (const line of out.trim().split('\n')) {
        const [pid, rss, cpu] = line.trim().split(/\s+/);
        samples.push({ pid: Number(pid), rssMb: Number(rss) / 1024, cpu: Number(cpu) });
      }
    } catch {
      /* process gone */
    }
  }, everyMs);
  return {
    stop() {
      clearInterval(timer);
      const by = {};
      for (const s of samples) (by[s.pid] ??= []).push(s);
      return Object.fromEntries(
        Object.entries(by).map(([pid, ss]) => [
          pid,
          {
            peakRssMb: Math.round(Math.max(...ss.map((s) => s.rssMb))),
            avgCpu: Math.round(ss.reduce((a, s) => a + s.cpu, 0) / ss.length),
            peakCpu: Math.round(Math.max(...ss.map((s) => s.cpu))),
          },
        ]),
      );
    },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
