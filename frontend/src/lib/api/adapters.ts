/**
 * Maps API DTOs onto the view models the existing pages already render
 * (RoomState, Profile, Order, Notice), so no page needs to change.
 */
import { images } from "@/lib/auctions";
import type { Notice, RoomState } from "@/lib/auction-store";
import type { Order, Profile } from "@/lib/demo-session";
import { minorToMajor } from "./client";
import type {
  AuctionDto,
  BidDto,
  ImageDto,
  LiveState,
  MeDto,
  NotificationDto,
  OrderDto,
} from "./types";
import { photoFromUrl, type Photo } from "@/lib/media";

const FALLBACK_IMAGE: Record<string, string> = {
  cars: images.car,
  watches: images.watch,
  jewelry: images.jewelry,
  art: images.art,
  "real-estate": images.house,
  collectibles: images.antique,
};
const CONDITION: Record<AuctionDto["condition"], RoomState["condition"]> = {
  NEW: "New",
  EXCELLENT: "Excellent",
  VERY_GOOD: "Very Good",
  GOOD: "Good",
  FAIR: "Fair",
  POOR: "Fair",
};

/** Server clock minus local clock, refreshed on every server timestamp we see. */
let clockOffsetMs = 0;
let measured = false;
/** Coarse offset from a response timestamp; ignored once an NTP-style sample exists. */
export function syncClock(serverTimeIso: string) {
  if (measured) return;
  const offset = Date.parse(serverTimeIso) - Date.now();
  if (Number.isFinite(offset)) clockOffsetMs = offset;
}
/** Precise offset (server − local) measured with round-trip compensation. */
export function setClockOffset(ms: number) {
  if (!Number.isFinite(ms)) return;
  measured = true;
  clockOffsetMs = ms;
}
export const getClockOffset = () => clockOffsetMs;
/** A server timestamp expressed on the local clock (what countdowns compare against Date.now()). */
const local = (iso: string) => Date.parse(iso) - clockOffsetMs;

export function mediaUrl(url: string, categorySlug: string): string {
  const asset = /^asset:\/\/([a-z-]+)$/.exec(url)?.[1];
  if (asset)
    return (
      (images as Record<string, string>)[asset] ?? FALLBACK_IMAGE[categorySlug] ?? images.antique
    );
  return url;
}

/** API image → UI photo with its size variants (uploaded photos) or a single URL. */
export function toPhoto(m: ImageDto, categorySlug: string): Photo {
  if (!m.variants) return photoFromUrl(mediaUrl(m.url, categorySlug), m.altText ?? undefined);
  const v = m.variants;
  return {
    thumb: v.thumbnail.url,
    card: v.card.url,
    full: v.full.url,
    widths: { thumb: v.thumbnail.width, card: v.card.width, full: v.full.width },
    width: v.full.width,
    height: v.full.height,
    ...(m.altText ? { alt: m.altText } : {}),
    ...(m.credit ? { credit: m.credit } : {}),
  };
}

const statusOf = (phase: LiveState["phase"]): RoomState["status"] =>
  phase === "live" ? "live" : phase === "upcoming" ? "upcoming" : "ended";

const reserveOf = (r: LiveState["reserve"]): RoomState["reserve"] =>
  r === "not_met" ? "not-met" : r;

export function toBid(b: BidDto, mine = b.mine): RoomState["bids"][number] {
  return {
    id: b.id,
    user: mine ? "you" : b.bidderAlias,
    amount: minorToMajor(b.amount.minor, b.amount.currency),
    at: local(b.createdAt),
    ...(mine ? { mine: true } : {}),
  };
}

export function toRoom(a: AuctionDto, bids: BidDto[] | null, previous?: RoomState): RoomState {
  syncClock(a.serverTime);
  const cur = a.currency;
  const startBid = minorToMajor(a.startingPrice.minor, cur);
  const currentBid = a.currentPrice ? minorToMajor(a.currentPrice.minor, cur) : startBid;
  const startsAt = local(a.startsAt);
  const endsAt = local(a.endsAt);
  const status = statusOf(a.phase);
  const specs: [string, string][] = a.attributes
    .filter((x) => x.value !== null)
    .map((x) => [
      x.label,
      typeof x.value === "boolean"
        ? x.value
          ? "Yes"
          : "No"
        : `${x.value}${x.unit ? ` ${x.unit}` : ""}`,
    ]);
  if (a.vehicle) {
    const v = a.vehicle;
    specs.unshift(["Vehicle", `${v["year"] ?? ""} ${v["make"] ?? ""} ${v["model"] ?? ""}`.trim()]);
    if (v["mileageKm"] !== null && v["mileageKm"] !== undefined)
      specs.push(["Mileage", `${Number(v["mileageKm"]).toLocaleString("en-US")} km`]);
    if (v["transmission"]) specs.push(["Transmission", String(v["transmission"])]);
  }
  if (a.watch) {
    const w = a.watch;
    specs.unshift(["Watch", `${w["brand"] ?? ""} ${w["model"] ?? ""}`.trim()]);
    if (w["caseDiameterMm"])
      specs.push(["Case", `${w["caseDiameterMm"]}mm ${w["caseMaterial"] ?? ""}`.trim()]);
    if (w["movement"]) specs.push(["Movement", String(w["movement"])]);
    if (w["year"]) specs.push(["Year", String(w["year"])]);
    if (w["hasBox"] !== null && w["hasBox"] !== undefined)
      specs.push([
        "Box & Papers",
        w["hasBox"] && w["hasPapers"] ? "Yes" : w["hasBox"] ? "Box only" : "No",
      ]);
  }

  let roomBids = bids ? bids.map((b) => toBid(b)) : (previous?.bids ?? []);
  if (!bids && !previous && a.highestBid) {
    // List view without history: show the current top bid so "leading" states render.
    roomBids = [
      {
        id: `top-${a.id}`,
        user: a.highestBid.mine ? "you" : a.highestBid.bidderAlias,
        amount: minorToMajor(a.highestBid.amount.minor, cur),
        at: local(a.highestBid.createdAt),
        ...(a.highestBid.mine ? { mine: true } : {}),
      },
    ];
  }
  const location = [a.location.city, a.location.country].filter(Boolean).join(", ");
  const buyNow = a.buyNowPrice ? minorToMajor(a.buyNowPrice.minor, cur) : undefined;

  return {
    id: a.id,
    lot: `LOT ${a.lotNumber}`,
    title: a.title,
    // Categories come from PostgreSQL, so admin-created ones work without frontend changes.
    category: a.category.name,
    categorySlug: a.category.slug,
    ...(a.subcategory
      ? { subcategory: a.subcategory.name, subcategorySlug: a.subcategory.slug }
      : {}),
    images: a.media.length
      ? a.media.map((m) => mediaUrl(m.url, a.category.slug))
      : [FALLBACK_IMAGE[a.category.slug] ?? images.antique],
    ...(a.media.length ? { photos: a.media.map((m) => toPhoto(m, a.category.slug)) } : {}),
    location: location || "—",
    condition: CONDITION[a.condition],
    seller: a.seller.displayName,
    ...(a.seller.handle ? { sellerHandle: a.seller.handle } : {}),
    sellerType: a.seller.type === "PRIVATE" ? "Private" : "Dealer",
    verified: a.seller.verified,
    startBid,
    currentBid,
    increment: minorToMajor(a.minIncrement.minor, cur),
    ...(buyNow === undefined ? {} : { buyNow }),
    reserve: reserveOf(a.reserve),
    watchers: a.watcherCount,
    viewers: previous?.viewers ?? a.watcherCount,
    durationSec: Math.max(0, Math.round((endsAt - startsAt) / 1000)),
    ...(status === "upcoming"
      ? { startsInSec: Math.max(0, Math.round((startsAt - Date.now()) / 1000)) }
      : {}),
    listedDaysAgo: Math.max(0, Math.floor((Date.now() - Date.parse(a.createdAt)) / 86_400_000)),
    specs,
    description: a.description,
    inspection: a.inspectionNotes ?? "No independent inspection has been verified by AUCTRA.",
    shipping:
      a.shippingNotes ?? "Shipping and collection are arranged with the seller after the sale.",
    startsAt,
    endsAt,
    status,
    bids: roomBids,
    // Room chat is server-backed in API mode (see LiveChat); this field is demo-only.
    chat: previous?.chat ?? [],
    participants: [...new Set(roomBids.map((b) => b.user))],
    lastBidAt: roomBids[0]?.at ?? startsAt,
    version: a.version,
    minNextBid: minorToMajor(a.minimumNextBid.minor, cur),
    currency: cur,
    ...(a.result ? { wonByMe: a.result.wonByMe } : {}),
    ...(a.viewer?.isSeller ? { viewerIsSeller: true } : {}),
    ...(a.demo ? { demo: true } : {}),
  };
}

/** Applies a realtime live-state snapshot to an existing room. */
export function applyLiveState(room: RoomState, s: LiveState, currency: string): RoomState {
  syncClock(s.serverTime);
  return {
    ...room,
    status: statusOf(s.phase),
    startsAt: local(s.startsAt),
    endsAt: local(s.endsAt),
    currentBid: s.currentPrice ? minorToMajor(s.currentPrice.minor, currency) : room.startBid,
    minNextBid: minorToMajor(s.minimumNextBid.minor, currency),
    reserve: reserveOf(s.reserve),
    version: s.version,
  };
}

export function toProfile(
  me: MeDto,
  prefs?: { outbid: boolean; ending: boolean; email: boolean },
): Profile {
  return {
    name: me.profile?.displayName ?? me.email.split("@")[0] ?? "",
    email: me.email,
    handle: me.profile?.handle ?? "you",
    phone: me.profile?.phone ?? "",
    country: countryName(me.profile?.country ?? null),
    emailAlerts: prefs?.email ?? true,
    outbidAlerts: prefs?.outbid ?? true,
    endingAlerts: prefs?.ending ?? true,
    id: me.id,
    emailVerified: me.emailVerified,
    roles: me.roles,
    permissions: me.permissions,
  };
}

const COUNTRIES: Record<string, string> = {
  US: "United States",
  GB: "United Kingdom",
  CA: "Canada",
  DE: "Germany",
  FR: "France",
  IT: "Italy",
  ES: "Spain",
  CH: "Switzerland",
  AE: "United Arab Emirates",
  JP: "Japan",
  AU: "Australia",
  AM: "Armenia",
};
export const countryName = (code: string | null) =>
  code ? (COUNTRIES[code] ?? code) : "United States";
export function countryCode(name: string): string | undefined {
  const trimmed = name.trim();
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
  return Object.entries(COUNTRIES).find(([, n]) => n.toLowerCase() === trimmed.toLowerCase())?.[0];
}

const ORDER_STATUS: Record<string, Order["status"]> = {
  PENDING_PAYMENT: "pending_payment",
  PAYMENT_PROCESSING: "processing",
  PAID: "processing",
  SHIPPED: "shipped",
  DELIVERED: "delivered",
  COMPLETED: "completed",
  DISPUTED: "disputed",
  CANCELLED: "cancelled",
  REFUNDED: "cancelled",
};

export function toOrder(o: OrderDto): Order {
  return {
    id: o.orderNumber,
    auctionId: o.auction.id,
    title: o.auction.title,
    image: o.auction.image ? mediaUrl(o.auction.image, "") : undefined,
    hammer: minorToMajor(o.hammerPrice.minor, o.hammerPrice.currency),
    status: ORDER_STATUS[o.status] ?? "processing",
    date: (o.demoCompletedAt ?? o.createdAt).slice(0, 10),
    total: minorToMajor(o.total.minor, o.total.currency),
    currency: o.total.currency,
    simulated: o.simulated ?? true,
    orderId: o.id,
  };
}

const NOTICE_KIND: Record<string, Notice["kind"]> = {
  OUTBID: "outbid",
  AUCTION_WON: "won",
  AUCTION_SOLD: "won",
  AUCTION_APPROVED: "won",
  AUCTION_LOST: "lost",
  AUCTION_UNSOLD: "lost",
  AUCTION_REJECTED: "lost",
  ACCOUNT_SECURITY: "outbid",
  AUCTION_ENDING_SOON: "ending",
  AUCTION_REMINDER: "ending",
  AUCTION_STARTED: "ending",
};

export function toNotice(n: NotificationDto): Notice {
  return {
    id: n.id,
    kind: NOTICE_KIND[n.type] ?? "leading",
    auctionId: n.auctionId ?? "",
    text: n.title,
    at: Date.parse(n.createdAt),
    read: n.read,
    type: n.type,
    body: n.body,
    link: n.link,
  };
}
