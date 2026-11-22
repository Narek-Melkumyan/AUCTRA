/**
 * Child process holding N Socket.IO viewers (spawned by run.mjs so client-side parsing
 * does not distort latency measurements in the coordinator).
 *
 * Each viewer joins one auction room and mirrors the real frontend logic: it keeps the
 * auction version from the join snapshot, applies `auction:bid` / `auction:state` only
 * when version = held + 1, ignores duplicates/old versions, and calls `auction:sync` on a
 * gap. The coordinator talks to this process over IPC.
 */
import { io } from 'socket.io-client';

const api = process.env.VIEWER_API;
const count = Number(process.env.VIEWER_COUNT);
const auctions = JSON.parse(process.env.VIEWER_AUCTIONS);
const tokens = JSON.parse(process.env.VIEWER_TOKENS ?? '[]');
const viewers = [];
const stats = { connected: 0, joinFailed: 0, connectErrors: 0, gaps: 0, dupes: 0, syncs: 0 };
// eventKey -> receive times (ms epoch, high resolution)
const received = new Map();

function now() {
  return performance.timeOrigin + performance.now();
}

function makeViewer(i) {
  const auctionId = auctions[i % auctions.length];
  const token = tokens.length ? tokens[i % tokens.length] : undefined;
  const v = { i, auctionId, version: 0, socket: null, joined: false };
  const s = io(api, {
    path: '/socket.io',
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 3000,
    auth: token ? { token } : {},
    forceNew: true,
  });
  v.socket = s;
  const join = async (event = 'auction:join') => {
    const ack = await s.timeout(15_000).emitWithAck(event, { auctionId }).catch(() => null);
    if (!ack?.ok) {
      stats.joinFailed++;
      return;
    }
    if (ack.auction.version >= v.version) v.version = ack.auction.version;
    if (event === 'auction:sync') stats.syncs++;
    v.joined = true;
  };
  s.on('connect', () => {
    stats.connected++;
    void join();
  });
  s.on('disconnect', () => {
    stats.connected--;
    v.joined = false;
  });
  s.on('connect_error', () => stats.connectErrors++);
  const onEvent = (e) => {
    const t = now();
    if (e.auctionId !== auctionId) return;
    if (e.version <= v.version) {
      stats.dupes++;
      return;
    }
    if (e.version > v.version + 1) {
      stats.gaps++;
      void join('auction:sync');
      return;
    }
    v.version = e.version;
    const key = `${e.auctionId}:${e.version}`;
    let arr = received.get(key);
    if (!arr) received.set(key, (arr = []));
    arr.push(t);
  };
  s.on('auction:bid', onEvent);
  s.on('auction:state', onEvent);
  return v;
}

// Never outlive the coordinator (an orphaned worker would reconnect forever).
process.on('disconnect', () => process.exit(0));

process.on('message', async (msg) => {
  if (msg.cmd === 'start') {
    const t0 = now();
    // Connect in waves to stay within the listen backlog.
    for (let i = 0; i < count; i++) {
      viewers.push(makeViewer(msg.offset + i));
      if (i % 200 === 199) await new Promise((r) => setTimeout(r, 50));
    }
    const deadline = Date.now() + 120_000;
    while (viewers.some((v) => !v.joined) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    process.send({ cmd: 'ready', joined: viewers.filter((v) => v.joined).length, ms: now() - t0, stats });
  } else if (msg.cmd === 'collect') {
    const out = {};
    for (const k of msg.keys) out[k] = received.get(k) ?? [];
    process.send({ cmd: 'collected', out, stats, versions: viewers.map((v) => v.version) });
  } else if (msg.cmd === 'reset') {
    received.clear();
    process.send({ cmd: 'reset-ok' });
  } else if (msg.cmd === 'disconnect') {
    for (const v of viewers.slice(0, msg.n ?? viewers.length)) v.socket.disconnect();
    process.send({ cmd: 'disconnected' });
  } else if (msg.cmd === 'reconnect') {
    const t0 = now();
    for (const v of viewers.slice(0, msg.n ?? viewers.length)) v.socket.connect();
    const deadline = Date.now() + 60_000;
    while (viewers.slice(0, msg.n ?? viewers.length).some((v) => !v.joined) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    process.send({ cmd: 'reconnected', ms: now() - t0, versions: viewers.map((v) => v.version) });
  } else if (msg.cmd === 'versions') {
    process.send({ cmd: 'versions', versions: viewers.map((v) => v.version), stats });
  } else if (msg.cmd === 'stop') {
    for (const v of viewers) v.socket.disconnect();
    process.exit(0);
  }
});
