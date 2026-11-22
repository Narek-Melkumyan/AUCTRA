import type { Prisma } from '../generated/prisma/client.js';
import { hmacHex } from '../common/crypto.js';
import { money, moneyOrNull, type MoneyDto } from '../common/money.js';
import { phaseOf, type AuctionPhase } from './auction-state.js';
import { toImageDto } from '../media/media.mapper.js';

/**
 * Bidders are shown under a per-auction pseudonym (e.g. "bidder_3f9a1c"): stable within
 * one auction, unlinkable across auctions, and never revealing account identity.
 */
export class BidderAliases {
  private readonly key: string;
  constructor(secret: string) {
    this.key = hmacHex(secret, 'auctra:bidder-alias:v1');
  }
  alias(auctionId: string, userId: string): string {
    return `bidder_${hmacHex(this.key, `${auctionId}:${userId}`).slice(0, 6)}`;
  }
}

export const auctionDetailInclude = {
  category: { select: { slug: true, name: true } },
  subcategory: { select: { slug: true, name: true } },
  seller: {
    select: {
      id: true,
      profile: { select: { handle: true, displayName: true } },
      sellerProfile: {
        select: { type: true, businessName: true, verificationStatus: true },
      },
    },
  },
  media: { orderBy: { position: 'asc' as const } },
  attributeValues: {
    include: {
      attribute: { select: { key: true, label: true, type: true, unit: true } },
    },
  },
  vehicle: true,
  watch: true,
  highestBid: {
    select: {
      id: true,
      bidderId: true,
      amountCents: true,
      createdAt: true,
      sequence: true,
    },
  },
  _count: { select: { watchers: true } },
} satisfies Prisma.AuctionInclude;

export type AuctionDetailRow = Prisma.AuctionGetPayload<{
  include: typeof auctionDetailInclude;
}>;

/** Fields needed to compute the live (realtime) state of an auction. */
export type LiveStateSource = Pick<
  AuctionDetailRow,
  | 'id'
  | 'status'
  | 'startsAt'
  | 'endsAt'
  | 'currency'
  | 'startingPriceCents'
  | 'minIncrementCents'
  | 'currentPriceCents'
  | 'reservePriceCents'
  | 'bidCount'
  | 'version'
  | 'winnerId'
>;

export type ReserveState = 'none' | 'met' | 'not_met';

export interface LiveStateDto {
  auctionId: string;
  version: number;
  status: string;
  phase: AuctionPhase;
  isAcceptingBids: boolean;
  startsAt: string;
  endsAt: string;
  currentPrice: MoneyDto | null;
  minimumNextBid: MoneyDto;
  bidCount: number;
  reserve: ReserveState;
  highestBidderAlias: string | null;
  serverTime: string;
}

export function reserveState(
  a: Pick<LiveStateSource, 'reservePriceCents' | 'currentPriceCents'>,
): ReserveState {
  if (a.reservePriceCents === null) return 'none';
  return a.currentPriceCents !== null &&
    a.currentPriceCents >= a.reservePriceCents
    ? 'met'
    : 'not_met';
}

export function minimumNextBid(
  a: Pick<
    LiveStateSource,
    'currentPriceCents' | 'startingPriceCents' | 'minIncrementCents'
  >,
): bigint {
  return a.currentPriceCents === null
    ? a.startingPriceCents
    : a.currentPriceCents + a.minIncrementCents;
}

export function toLiveState(
  a: LiveStateSource,
  highestBidderAlias: string | null,
  now: Date,
): LiveStateDto {
  const phase = phaseOf(a, now);
  return {
    auctionId: a.id,
    version: a.version,
    status: a.status,
    phase,
    isAcceptingBids: phase === 'live',
    startsAt: a.startsAt.toISOString(),
    endsAt: a.endsAt.toISOString(),
    currentPrice: moneyOrNull(a.currentPriceCents, a.currency),
    minimumNextBid: money(minimumNextBid(a), a.currency),
    bidCount: a.bidCount,
    reserve: reserveState(a),
    highestBidderAlias,
    serverTime: now.toISOString(),
  };
}

export interface Viewer {
  userId: string;
  canReadAny: boolean;
}

export function toAuctionDto(
  a: AuctionDetailRow,
  aliases: BidderAliases,
  now: Date,
  viewer?: Viewer,
  extra?: { watching?: boolean },
) {
  const isSeller = viewer?.userId === a.sellerId;
  const privileged = isSeller || Boolean(viewer?.canReadAny);
  const highestAlias = a.highestBid
    ? aliases.alias(a.id, a.highestBid.bidderId)
    : null;
  const live = toLiveState(a, highestAlias, now);
  const seller = a.seller;
  return {
    ...live,
    id: a.id,
    lotNumber: a.lotNumber,
    title: a.title,
    /** Seeded demonstration listing (not a real item for sale). */
    demo: a.seedKey !== null && a.seedKey !== undefined,
    description: a.description,
    category: a.category,
    subcategory: a.subcategory,
    condition: a.condition,
    conditionNotes: a.conditionNotes,
    location: {
      city: a.locationCity,
      region: a.locationRegion,
      country: a.locationCountry,
    },
    currency: a.currency,
    startingPrice: money(a.startingPriceCents, a.currency),
    minIncrement: money(a.minIncrementCents, a.currency),
    buyNowPrice: moneyOrNull(a.buyNowPriceCents, a.currency),
    originalEndsAt: a.originalEndsAt.toISOString(),
    visibility: a.visibility,
    antiSniping: {
      enabled: a.antiSnipingEnabled,
      windowSec: a.antiSnipingWindowSec,
      extensionSec: a.antiSnipingExtensionSec,
    },
    fulfillmentMethod: a.fulfillmentMethod,
    shippingNotes: a.shippingNotes,
    inspectionNotes: a.inspectionNotes,
    seller: {
      handle: seller.profile?.handle ?? null,
      displayName:
        seller.sellerProfile?.businessName ??
        seller.profile?.displayName ??
        'Seller',
      type: seller.sellerProfile?.type ?? 'PRIVATE',
      verified: seller.sellerProfile?.verificationStatus === 'VERIFIED',
    },
    media: a.media.map(toImageDto),
    attributes: a.attributeValues.map((v) => ({
      key: v.attribute.key,
      label: v.attribute.label,
      unit: v.attribute.unit,
      value: attributeValue(v),
    })),
    vehicle: a.vehicle ? { ...a.vehicle, auctionId: undefined } : null,
    watch: a.watch
      ? {
          ...a.watch,
          auctionId: undefined,
          caseDiameterMm: a.watch.caseDiameterMm?.toString() ?? null,
        }
      : null,
    highestBid: a.highestBid
      ? {
          bidderAlias: highestAlias,
          amount: money(a.highestBid.amountCents, a.currency),
          createdAt: a.highestBid.createdAt.toISOString(),
          mine: viewer?.userId === a.highestBid.bidderId,
        }
      : null,
    result:
      a.status === 'SOLD' || a.status === 'UNSOLD'
        ? {
            outcome:
              a.status === 'SOLD' ? ('sold' as const) : ('unsold' as const),
            hammerPrice:
              a.status === 'SOLD'
                ? moneyOrNull(a.currentPriceCents, a.currency)
                : null,
            winnerAlias: a.winnerId ? aliases.alias(a.id, a.winnerId) : null,
            wonByMe: Boolean(viewer && a.winnerId === viewer.userId),
          }
        : null,
    watcherCount: a._count.watchers,
    viewer: viewer
      ? {
          isSeller,
          isHighestBidder: viewer.userId === a.highestBid?.bidderId,
          watching: extra?.watching ?? false,
        }
      : null,
    // Owner/admin-only fields.
    ...(privileged
      ? {
          reservePrice: moneyOrNull(a.reservePriceCents, a.currency),
          cancelReason: a.cancelReason,
          submittedAt: a.submittedAt?.toISOString() ?? null,
          approvedAt: a.approvedAt?.toISOString() ?? null,
        }
      : {}),
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

export type AuctionDto = ReturnType<typeof toAuctionDto>;

function attributeValue(
  v: AuctionDetailRow['attributeValues'][number],
): string | boolean | null {
  if (v.valueText !== null) return v.valueText;
  if (v.valueNumber !== null) return v.valueNumber.toString();
  if (v.valueBoolean !== null) return v.valueBoolean;
  if (v.valueDate !== null) return v.valueDate.toISOString().slice(0, 10);
  return null;
}
