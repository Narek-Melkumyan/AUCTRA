/**
 * Database invariants for the auction engine. Checked after every load scenario
 * straight from PostgreSQL (the source of truth), never from API responses.
 */

/** Returns a list of violated invariants for one auction (empty = healthy). */
export async function checkAuction(db, auctionId, opts = {}) {
  const v = [];
  const a = (
    await db.query(
      `SELECT id, status, "startingPriceCents" AS start, "minIncrementCents" AS inc,
              "currentPriceCents" AS price, "highestBidId" AS hb, "bidCount" AS n,
              "winnerId", "winningBidId", "endsAt", "reservePriceCents" AS reserve
       FROM auctions WHERE id = $1`,
      [auctionId],
    )
  ).rows[0];
  if (!a) return [`auction ${auctionId} missing`];
  const bids = (
    await db.query(
      `SELECT b.id, b.sequence, b."amountCents" AS amount, b."bidderId", b."createdAt",
              b."previousPriceCents" AS prev, u.id AS uid, b."idempotencyKey" AS key
       FROM bids b LEFT JOIN users u ON u.id = b."bidderId"
       WHERE b."auctionId" = $1 AND b.status = 'ACCEPTED' ORDER BY b.sequence`,
      [auctionId],
    )
  ).rows;

  // 1. Every accepted bid has a valid auction (FK) and bidder.
  for (const b of bids) if (!b.uid) v.push(`bid ${b.id} has no bidder`);
  // 4. Sequences are 1..n, unique and contiguous.
  bids.forEach((b, i) => {
    if (b.sequence !== i + 1) v.push(`sequence gap/duplicate at index ${i}: got ${b.sequence}`);
  });
  if (Number(a.n) !== bids.length) v.push(`bidCount ${a.n} != accepted bids ${bids.length}`);
  // 2. Amounts follow minimum-bid rules in serialized order.
  bids.forEach((b, i) => {
    const amount = BigInt(b.amount);
    if (i === 0) {
      if (amount < BigInt(a.start)) v.push(`first bid ${amount} below start ${a.start}`);
      if (b.prev !== null) v.push(`first bid has previousPrice ${b.prev}`);
    } else {
      const prev = BigInt(bids[i - 1].amount);
      if (amount < prev + BigInt(a.inc)) v.push(`seq ${b.sequence}: ${amount} < ${prev} + ${a.inc}`);
      if (b.prev === null || BigInt(b.prev) !== prev) v.push(`seq ${b.sequence}: previousPrice ${b.prev} != ${prev}`);
    }
    // Consecutive bids by the same bidder are forbidden (no self-outbidding).
    if (i > 0 && bids[i - 1].bidderId === b.bidderId) v.push(`seq ${b.sequence}: same bidder twice in a row`);
  });
  // 3. Highest bid == latest accepted bid.
  const last = bids.at(-1);
  if (last) {
    if (a.hb !== last.id) v.push(`highestBidId ${a.hb} != last bid ${last.id}`);
    if (BigInt(a.price) !== BigInt(last.amount)) v.push(`currentPrice ${a.price} != last bid ${last.amount}`);
  } else if (a.hb !== null || a.price !== null) v.push('price/highest set without bids');
  // 6. No bid accepted at or after the (final) deadline.
  for (const b of bids) if (new Date(b.createdAt) >= new Date(a.endsAt)) v.push(`bid ${b.sequence} created after endsAt`);
  // 5. Idempotency keys unique per bidder (DB constraint) — double-check.
  const keys = new Set();
  for (const b of bids) {
    const k = `${b.bidderId}:${b.key}`;
    if (keys.has(k)) v.push(`duplicate idempotency key ${k}`);
    keys.add(k);
  }
  // 7./8. Settlement: only a valid winner, at most one order.
  const orders = (await db.query(`SELECT id, "buyerId", "hammerPriceCents" AS hammer FROM orders WHERE "auctionId" = $1`, [auctionId])).rows;
  if (orders.length > 1) v.push(`${orders.length} orders`);
  if (a.status === 'SOLD') {
    if (!last) v.push('SOLD without bids');
    else {
      if (a.winnerId !== last.bidderId) v.push(`winner ${a.winnerId} != highest bidder ${last.bidderId}`);
      if (a.winningBidId !== last.id) v.push('winningBidId != highest bid');
      if (a.reserve !== null && BigInt(last.amount) < BigInt(a.reserve)) v.push('SOLD below reserve');
      if (orders.length !== 1) v.push('SOLD without exactly one order');
      else if (orders[0].buyerId !== last.bidderId || BigInt(orders[0].hammer) !== BigInt(last.amount))
        v.push('order buyer/hammer mismatch');
    }
  } else {
    if (a.winnerId) v.push(`status ${a.status} but winner set`);
    if (orders.length) v.push(`status ${a.status} but has an order`);
  }
  if (opts.expectedAccepted !== undefined && opts.expectedAccepted !== bids.length)
    v.push(`expected ${opts.expectedAccepted} accepted bids in DB, found ${bids.length}`);
  return v;
}

/** Checks the cross-cutting invariants plus every auction id given. */
export async function checkAll(db, auctionIds) {
  const out = {};
  for (const id of auctionIds) {
    const v = await checkAuction(db, id);
    if (v.length) out[id] = v;
  }
  const stuck = (
    await db.query(
      `SELECT count(*)::int AS n FROM outbox_events WHERE "publishedAt" IS NULL AND "createdAt" < now() - interval '30 seconds'`,
    )
  ).rows[0].n;
  if (stuck) out['outbox'] = [`${stuck} outbox events unpublished for >30s`];
  return out;
}
