import { HttpStatus, Injectable } from '@nestjs/common';
import { AppConfig } from '../config/app-config.js';
import { AppError } from '../common/errors.js';

/**
 * Per-instance admission control for bid transactions.
 *
 * This is a PERFORMANCE guard, not a correctness mechanism: correctness comes from the
 * PostgreSQL row lock (`SELECT … FOR UPDATE`) inside the transaction, which serialises
 * bids across all API instances.
 *
 * Why it exists: without it, a burst of N bids on one hot auction would open N
 * transactions that each hold a pooled connection while waiting for the same row
 * lock, starving every other auction (and every read) of connections. With the gate:
 *  - bids for one auction run one at a time per instance (FIFO), so a hot auction
 *    occupies at most one pooled connection per instance while it waits;
 *  - all bid transactions together use at most `maxConcurrent` connections, leaving
 *    headroom in the pool for reads, chat and the workers;
 *  - each auction's queue is bounded; beyond it the request is refused immediately
 *    with a retryable 503 instead of piling up (callers retry with the same
 *    Idempotency-Key, which is always safe).
 */
@Injectable()
export class BidGate {
  private readonly tails = new Map<
    string,
    { tail: Promise<void>; depth: number }
  >();
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  readonly maxConcurrent: number;
  readonly maxQueue: number;

  constructor(config: AppConfig) {
    this.maxConcurrent = config.bidMaxConcurrentTx;
    this.maxQueue = config.bidQueueMaxPerAuction;
  }

  /** Current queue depth per auction and global usage (for metrics/tests). */
  stats() {
    return {
      active: this.active,
      waitingForSlot: this.waiters.length,
      queuedAuctions: this.tails.size,
    };
  }

  async run<T>(auctionId: string, fn: () => Promise<T>): Promise<T> {
    let entry = this.tails.get(auctionId);
    if (entry && entry.depth >= this.maxQueue) {
      throw new AppError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'AUCTION_BUSY',
        'This auction is receiving too many bids right now. Your bid was not placed — retry in a moment.',
        { retryAfterMs: 500 },
      );
    }
    if (!entry) {
      entry = { tail: Promise.resolve(), depth: 0 };
      this.tails.set(auctionId, entry);
    }
    entry.depth++;
    const previous = entry.tail;
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    entry.tail = previous.then(() => mine);
    const e = entry;
    try {
      await previous;
      await this.acquire();
      try {
        return await fn();
      } finally {
        this.releaseSlot();
      }
    } finally {
      release();
      e.depth--;
      if (e.depth === 0 && this.tails.get(auctionId) === e)
        this.tails.delete(auctionId);
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) =>
      this.waiters.push(() => {
        this.active++;
        resolve();
      }),
    );
  }

  private releaseSlot() {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }
}
