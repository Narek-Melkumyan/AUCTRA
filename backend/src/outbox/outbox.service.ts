import { Global, Injectable, Module } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import type { Tx } from '../prisma/prisma.service.js';

export interface OutboxMessage {
  /** 'job' rows are internal background work (never broadcast); see JobProcessor. */
  aggregateType: 'auction' | 'user' | 'chat' | 'job';
  aggregateId: string;
  /** Aggregate version after the change (0 for unversioned aggregates such as user inboxes). */
  version: number;
  type: string;
  payload: Prisma.InputJsonValue;
}

type Listener = () => void;

/**
 * Transactional outbox writer. Call `enqueue` with the SAME transaction client that
 * performs the state change: the event exists if and only if the change committed.
 * After commit, call `kick()` so the relay publishes immediately instead of waiting
 * for its next polling tick.
 */
@Injectable()
export class OutboxService {
  private listeners = new Set<Listener>();

  async enqueue(tx: Tx, msg: OutboxMessage): Promise<void> {
    await tx.outboxEvent.create({ data: msg });
  }

  async enqueueMany(tx: Tx, msgs: OutboxMessage[]): Promise<void> {
    if (msgs.length) await tx.outboxEvent.createMany({ data: msgs });
  }

  onKick(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  kick() {
    for (const l of this.listeners) l();
  }
}

@Global()
@Module({ providers: [OutboxService], exports: [OutboxService] })
export class OutboxModule {}
