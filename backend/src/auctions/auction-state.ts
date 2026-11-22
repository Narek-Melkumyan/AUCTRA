import type { AuctionStatus } from '../generated/prisma/client.js';
import { Errors } from '../common/errors.js';

/**
 * Auction lifecycle state machine. All status changes go through `assertTransition`.
 *
 *   DRAFT ──submit──▶ PENDING_REVIEW ──approve──▶ SCHEDULED ──startsAt──▶ LIVE ──endsAt──▶ ENDED ──settle──▶ SOLD | UNSOLD
 *     │  └─submit (review disabled)────────────────▲   │                    │
 *     │                 └──reject──▶ DRAFT          │   │                    │
 *     └────────────── cancel ───────────────────────┴───┴────── cancel ──────┘──▶ CANCELLED
 *
 * SOLD, UNSOLD and CANCELLED are terminal.
 */
export const TRANSITIONS: Readonly<
  Record<AuctionStatus, readonly AuctionStatus[]>
> = {
  DRAFT: ['PENDING_REVIEW', 'SCHEDULED', 'CANCELLED'],
  PENDING_REVIEW: ['SCHEDULED', 'DRAFT', 'CANCELLED'],
  SCHEDULED: ['LIVE', 'CANCELLED'],
  LIVE: ['ENDED', 'CANCELLED'],
  ENDED: ['SOLD', 'UNSOLD'],
  SOLD: [],
  UNSOLD: [],
  CANCELLED: [],
};

export function canTransition(from: AuctionStatus, to: AuctionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: AuctionStatus, to: AuctionStatus): void {
  if (!canTransition(from, to)) {
    throw Errors.conflict(
      'INVALID_STATUS_TRANSITION',
      `An auction cannot move from ${from} to ${to}.`,
      { from, to },
    );
  }
}

export type AuctionPhase =
  'draft' | 'pending_review' | 'upcoming' | 'live' | 'ended' | 'cancelled';

/**
 * Presentation phase derived from the stored status AND authoritative time, so an
 * auction whose end has passed reads as ended even before the closing job runs.
 */
export function phaseOf(
  a: { status: AuctionStatus; startsAt: Date; endsAt: Date },
  now: Date,
): AuctionPhase {
  switch (a.status) {
    case 'DRAFT':
      return 'draft';
    case 'PENDING_REVIEW':
      return 'pending_review';
    case 'CANCELLED':
      return 'cancelled';
    case 'SCHEDULED':
      if (now >= a.endsAt) return 'ended';
      return now >= a.startsAt ? 'live' : 'upcoming';
    case 'LIVE':
      return now >= a.endsAt ? 'ended' : 'live';
    case 'ENDED':
    case 'SOLD':
    case 'UNSOLD':
      return 'ended';
  }
}

/** Statuses visible on public listing/detail endpoints. */
export const PUBLIC_STATUSES: AuctionStatus[] = [
  'SCHEDULED',
  'LIVE',
  'ENDED',
  'SOLD',
  'UNSOLD',
  'CANCELLED',
];
