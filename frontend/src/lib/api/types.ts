/** Response shapes of the AUCTRA API (mirrors the backend mappers). Money is always a string. */
export type Money = { minor: string; currency: string };

export type Phase = "draft" | "pending_review" | "upcoming" | "live" | "ended" | "cancelled";

export type LiveState = {
  auctionId: string;
  version: number;
  status: string;
  phase: Phase;
  isAcceptingBids: boolean;
  startsAt: string;
  endsAt: string;
  currentPrice: Money | null;
  minimumNextBid: Money;
  bidCount: number;
  reserve: "none" | "met" | "not_met";
  highestBidderAlias: string | null;
  serverTime: string;
};

export type AuctionDto = LiveState & {
  id: string;
  lotNumber: number;
  /** Seeded demonstration listing (not a real item for sale). */
  demo?: boolean;
  title: string;
  description: string;
  category: { slug: string; name: string };
  subcategory: { slug: string; name: string } | null;
  condition: "NEW" | "EXCELLENT" | "VERY_GOOD" | "GOOD" | "FAIR" | "POOR";
  location: { city: string | null; region: string | null; country: string | null };
  currency: string;
  startingPrice: Money;
  minIncrement: Money;
  buyNowPrice: Money | null;
  seller: { handle: string | null; displayName: string; type: string; verified: boolean };
  media: ImageDto[];
  attributes: { key: string; label: string; unit: string | null; value: string | boolean | null }[];
  vehicle: Record<string, string | number | null> | null;
  watch: Record<string, string | number | boolean | null> | null;
  highestBid: { bidderAlias: string; amount: Money; createdAt: string; mine: boolean } | null;
  result: {
    outcome: "sold" | "unsold";
    hammerPrice: Money | null;
    winnerAlias: string | null;
    wonByMe: boolean;
  } | null;
  watcherCount: number;
  inspectionNotes: string | null;
  shippingNotes: string | null;
  conditionNotes: string | null;
  fulfillmentMethod: "SHIPPING" | "PICKUP" | "ARRANGED";
  /** Owner/admin only. */
  reservePrice?: Money | null;
  viewer: { isSeller: boolean; isHighestBidder: boolean; watching: boolean } | null;
  createdAt: string;
};

export type ImageVariant = { url: string; width: number; height: number; bytes: number };

/** A listing image (GET /auctions/:id/images, and `media` on auctions). */
export type ImageDto = {
  id: string;
  /** Full-size URL (https://, or asset://name for bundled demo images). */
  url: string;
  type: string;
  altText: string | null;
  position: number;
  isPrimary: boolean;
  storage: "external" | "bundled" | "r2" | "local";
  width: number | null;
  height: number | null;
  mimeType: string | null;
  bytes: number | null;
  /** Present for uploaded photos: 320 / 800 / 1600 px WebP (never upscaled). */
  variants: { thumbnail: ImageVariant; card: ImageVariant; full: ImageVariant } | null;
  /** Attribution for third-party photos (e.g. Wikimedia Commons); null for seller uploads. */
  credit?: {
    author: string | null;
    license: string;
    licenseUrl: string | null;
    sourceUrl: string | null;
    /** Modification details / illustrative-photo disclaimer. */
    notice?: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
};

export type BidDto = {
  id: string;
  sequence: number;
  amount: Money;
  bidderAlias: string;
  mine: boolean;
  createdAt: string;
};

export type MeDto = {
  id: string;
  email: string;
  emailVerified: boolean;
  status: string;
  profile: {
    displayName: string;
    handle: string;
    phone: string | null;
    country: string | null;
  } | null;
  roles: string[];
  permissions: string[];
};

export type NotificationDto = {
  id: string;
  type: string;
  title: string;
  body: string;
  auctionId: string | null;
  link: string | null;
  read: boolean;
  createdAt: string;
};

export type OrderDto = {
  id: string;
  orderNumber: string;
  role: "buyer" | "seller";
  status: string;
  auction: { id: string; title: string; image: string | null };
  hammerPrice: Money;
  buyerPremium?: Money;
  shipping?: Money;
  total: Money;
  createdAt: string;
  simulated?: boolean;
  demoCompletedAt?: string | null;
};

export type MyBidDto = {
  auctionId: string;
  myHighestBid: Money;
  leading: boolean;
  lastBidAt: string | null;
  state: LiveState;
};
