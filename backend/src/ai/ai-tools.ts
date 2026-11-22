import { Injectable } from '@nestjs/common';
import type { AuctionStatus, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AdminInsightsService } from '../admin/admin-insights.service.js';
import { phaseOf, PUBLIC_STATUSES } from '../auctions/auction-state.js';
import { minimumNextBid, reserveState } from '../auctions/auction.mapper.js';
import { money, SUPPORTED_CURRENCIES } from '../common/money.js';
import { Permission } from '../roles/permissions.js';
import type { AuthContext } from '../common/auth-context.js';
import type { LlmTool } from './llm.client.js';
import { cardUrl } from '../media/media.mapper.js';

export type AiScopeKey = 'USER' | 'ADMIN';

/** A real listing returned by a tool — the UI renders these cards, not model text. */
export interface ListingCard {
  id: string;
  title: string;
  category: string;
  phase: string;
  price: { minor: string; currency: string };
  formattedPrice: string;
  bidCount: number;
  endsAt: string;
  startsAt: string;
  image: string | null;
  link: string;
}

/** An admin action the assistant suggests. It is never executed by the assistant. */
export interface ProposedAction {
  action:
    | 'suspend_user'
    | 'ban_user'
    | 'mute_chat'
    | 'ban_chat'
    | 'hide_message'
    | 'cancel_auction';
  targetType: 'user' | 'chat_message' | 'auction';
  targetId: string;
  targetLabel: string;
  reason: string;
}

export interface ToolResult {
  /** JSON sent back to the model. */
  output: unknown;
  listings?: ListingCard[];
  proposal?: ProposedAction;
}

class ToolArgError extends Error {}

/** Marks user-generated text so the model treats it as data (see system instructions). */
const untrusted = (s: string | null | undefined, max = 600) =>
  s
    ? {
        untrusted_text: s
          .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
          .slice(0, max),
      }
    : null;

const fmt = (minor: bigint, currency: string) => {
  const digits =
    SUPPORTED_CURRENCIES[currency as keyof typeof SUPPORTED_CURRENCIES] ?? 2;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: digits,
  }).format(Number(minor) / 10 ** digits);
};

/** JSON-schema helper for strict function tools (every key required; nullable = optional). */
/** Plain-language timing for the model, so replies never echo raw ISO timestamps. */
export function timeLeft(endsAt: Date | string, now = Date.now()): string {
  const ms = new Date(endsAt).getTime() - now;
  const m = Math.round(Math.abs(ms) / 60_000);
  const span =
    m < 1
      ? 'less than a minute'
      : m < 60
        ? `${m} min`
        : m < 48 * 60
          ? `${Math.floor(m / 60)} h ${m % 60} min`
          : `${Math.round(m / 1440)} days`;
  return ms >= 0 ? `ends in ${span}` : `ended ${span} ago`;
}

const obj = (props: Record<string, unknown>) => ({
  type: 'object',
  properties: props,
  required: Object.keys(props),
  additionalProperties: false,
});
const nullable = (schema: Record<string, unknown>) => ({
  ...schema,
  type: [schema['type'] as string, 'null'],
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(
  v: unknown,
  name: string,
  max = 200,
  opts: { optional?: boolean } = {},
): string | undefined {
  if (v === null || v === undefined || v === '') {
    if (opts.optional) return undefined;
    throw new ToolArgError(`${name} is required`);
  }
  if (typeof v !== 'string') throw new ToolArgError(`${name} must be a string`);
  return v.trim().slice(0, max);
}
function num(v: unknown, name: string, min: number, max: number) {
  if (v === null || v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)
    throw new ToolArgError(
      `${name} must be a number between ${min} and ${max}`,
    );
  return v;
}
function oneOf<T extends string>(
  v: unknown,
  name: string,
  values: readonly T[],
) {
  if (v === null || v === undefined) return undefined;
  if (typeof v !== 'string' || !values.includes(v as T))
    throw new ToolArgError(`${name} must be one of ${values.join(', ')}`);
  return v as T;
}
function uuid(v: unknown, name: string) {
  const s = str(v, name, 36);
  if (!s || !UUID_RE.test(s)) throw new ToolArgError(`${name} must be a UUID`);
  return s;
}

const PHASES = ['live', 'upcoming', 'ended', 'any'] as const;
const CATEGORY_SLUGS = [
  'cars',
  'watches',
  'jewelry',
  'art',
  'real-estate',
  'collectibles',
] as const;
const TOPICS = [
  'bidding_rules',
  'auction_statuses',
  'fees',
  'demo_checkout',
  'account_and_verification',
  'selling',
  'chat_rules',
  'navigation',
] as const;

// ───────────── Tool definitions (what the model sees) ─────────────

const USER_TOOLS: LlmTool[] = [
  {
    type: 'function',
    name: 'search_auctions',
    description:
      'Search real AUCTRA auctions in the database. Use for any request to find, filter or compare listings. Returns at most 8 results with links.',
    strict: true,
    parameters: obj({
      query: nullable({
        type: 'string',
        description:
          'Free text matched against title, make/model (cars) and brand/model (watches), e.g. "BMW", "Rolex Submariner".',
      }),
      category: nullable({ type: 'string', enum: [...CATEGORY_SLUGS] }),
      phase: nullable({
        type: 'string',
        enum: [...PHASES],
        description:
          'live = bidding open now; upcoming = scheduled; ended = finished. Default any.',
      }),
      min_price: nullable({
        type: 'number',
        description:
          'Minimum current price in major units of currency (e.g. dollars).',
      }),
      max_price: nullable({
        type: 'number',
        description:
          'Maximum current price in major units (e.g. 50000 for $50,000).',
      }),
      currency: nullable({
        type: 'string',
        enum: Object.keys(SUPPORTED_CURRENCIES),
      }),
      sort: nullable({
        type: 'string',
        enum: ['ending_soon', 'price_low', 'price_high', 'most_bids', 'newest'],
      }),
    }),
  },
  {
    type: 'function',
    name: 'get_auction',
    description:
      'Get details of one auction (price, minimum next bid, reserve status, timing, condition, specs). Use the id from search results or the auction the user is viewing.',
    strict: true,
    parameters: obj({
      auction_id: { type: 'string', description: 'Auction UUID' },
    }),
  },
  {
    type: 'function',
    name: 'list_categories',
    description:
      'List auction categories with counts of live and upcoming auctions.',
    strict: true,
    parameters: obj({}),
  },
  {
    type: 'function',
    name: 'get_platform_info',
    description:
      'Authoritative AUCTRA rules and help text. Always use this instead of guessing about bidding rules, statuses, fees, the simulated checkout, accounts, selling, chat or navigation.',
    strict: true,
    parameters: obj({ topic: { type: 'string', enum: [...TOPICS] } }),
  },
  {
    type: 'function',
    name: 'get_my_bidding',
    description:
      "The signed-in user's own bids and watchlist with whether they are currently leading. Only for questions about the user's own activity.",
    strict: true,
    parameters: obj({}),
  },
];

const ADMIN_TOOLS: LlmTool[] = [
  {
    type: 'function',
    name: 'get_platform_analytics',
    description:
      'Platform KPIs from PostgreSQL: users, active users, auctions by status, bids, categories, most active auctions, demo checkout funnel.',
    strict: true,
    parameters: obj({
      days: nullable({ type: 'integer', minimum: 7, maximum: 180 }),
    }),
  },
  {
    type: 'function',
    name: 'get_bid_trends',
    description:
      'Daily bids, distinct bidders and new registrations over a period.',
    strict: true,
    parameters: obj({
      days: nullable({ type: 'integer', minimum: 7, maximum: 180 }),
    }),
  },
  {
    type: 'function',
    name: 'find_suspicious_bidding',
    description:
      'Heuristic integrity signals (shared networks, seller-network bidders, seller affinity, bursts). Signals only — never proof.',
    strict: true,
    parameters: obj({
      days: nullable({ type: 'integer', minimum: 1, maximum: 180 }),
    }),
  },
  {
    type: 'function',
    name: 'summarize_moderation',
    description:
      'Open reports (with what was reported), open order disputes, the number of listings awaiting review, active chat restrictions and the latest moderation actions.',
    strict: true,
    parameters: obj({}),
  },
  {
    type: 'function',
    name: 'search_users',
    description:
      'Find user accounts by handle or name, optionally filtered by status or role.',
    strict: true,
    parameters: obj({
      query: nullable({ type: 'string' }),
      status: nullable({
        type: 'string',
        enum: ['ACTIVE', 'SUSPENDED', 'BANNED'],
      }),
      role: nullable({
        type: 'string',
        enum: ['USER', 'SELLER', 'MODERATOR', 'ADMIN', 'SUPER_ADMIN'],
      }),
    }),
  },
  {
    type: 'function',
    name: 'get_user_activity',
    description:
      "One account's counts, recent bids, recent audit actions and restrictions.",
    strict: true,
    parameters: obj({ user_id: { type: 'string' } }),
  },
  {
    type: 'function',
    name: 'get_auction_performance',
    description:
      'Bid history (handles, amounts, timing), unique bidders, price progression and outcome of one auction.',
    strict: true,
    parameters: obj({ auction_id: { type: 'string' } }),
  },
  {
    type: 'function',
    name: 'propose_moderation_action',
    description:
      'Suggest a moderation action for a human administrator to review. This does NOT perform the action; the dashboard shows it as a card the admin must confirm.',
    strict: true,
    parameters: obj({
      action: {
        type: 'string',
        enum: [
          'suspend_user',
          'ban_user',
          'mute_chat',
          'ban_chat',
          'hide_message',
          'cancel_auction',
        ],
      },
      target_id: {
        type: 'string',
        description: 'UUID of the user, chat message or auction',
      },
      reason: { type: 'string', description: 'Short, factual justification' },
    }),
  },
];

export function toolsFor(scope: AiScopeKey, signedIn: boolean): LlmTool[] {
  if (scope === 'ADMIN') return ADMIN_TOOLS;
  return signedIn
    ? USER_TOOLS
    : USER_TOOLS.filter((t) => t.name !== 'get_my_bidding');
}

/** Tool names per scope — the executor refuses anything else (defence in depth). */
const ALLOWED: Record<AiScopeKey, Set<string>> = {
  USER: new Set(USER_TOOLS.map((t) => t.name)),
  ADMIN: new Set(ADMIN_TOOLS.map((t) => t.name)),
};

// ───────────── Executors (read-only, scoped) ─────────────

@Injectable()
export class AiToolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly insights: AdminInsightsService,
  ) {}

  async execute(
    scope: AiScopeKey,
    name: string,
    rawArgs: string,
    auth: AuthContext,
  ): Promise<ToolResult> {
    if (!ALLOWED[scope].has(name))
      return { output: { error: `Tool ${name} is not available.` } };
    if (scope === 'ADMIN' && !auth.permissions.has(Permission.AI_ADMIN))
      return { output: { error: 'Not authorised.' } };
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(rawArgs || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new ToolArgError('arguments must be an object');
      args = parsed as Record<string, unknown>;
    } catch {
      return {
        output: { error: 'Invalid tool arguments (expected JSON object).' },
      };
    }
    try {
      switch (name) {
        case 'search_auctions':
          return await this.searchAuctions(args);
        case 'get_auction':
          return await this.getAuction(args);
        case 'list_categories':
          return { output: await this.categories() };
        case 'get_platform_info':
          return { output: await this.platformInfo(args) };
        case 'get_my_bidding':
          return { output: await this.myBidding(auth) };
        case 'get_platform_analytics':
          return { output: await this.analytics(args) };
        case 'get_bid_trends':
          return { output: await this.trends(args) };
        case 'find_suspicious_bidding':
          return {
            output: {
              note: 'Heuristic signals for human review, not evidence of wrongdoing.',
              flags: await this.insights.suspiciousBidding(
                num(args['days'], 'days', 1, 180) ?? 30,
              ),
            },
          };
        case 'summarize_moderation':
          return { output: await this.moderation() };
        case 'search_users':
          return { output: await this.searchUsers(args) };
        case 'get_user_activity':
          return { output: await this.userActivity(args) };
        case 'get_auction_performance':
          return { output: await this.auctionPerformance(args) };
        case 'propose_moderation_action':
          return await this.propose(args);
        default:
          return { output: { error: 'Unknown tool.' } };
      }
    } catch (err) {
      if (err instanceof ToolArgError)
        return { output: { error: err.message } };
      if ((err as { status?: number }).status === 404)
        return { output: { error: 'Not found.' } };
      throw err;
    }
  }

  // ── user tools

  private async searchAuctions(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const query = str(args['query'], 'query', 80, { optional: true });
    const category = oneOf(args['category'], 'category', CATEGORY_SLUGS);
    const phase = oneOf(args['phase'], 'phase', PHASES) ?? 'any';
    const minPrice = num(args['min_price'], 'min_price', 0, 1e12);
    const maxPrice = num(args['max_price'], 'max_price', 0, 1e12);
    const currency =
      oneOf(args['currency'], 'currency', Object.keys(SUPPORTED_CURRENCIES)) ??
      undefined;
    const sort =
      oneOf(args['sort'], 'sort', [
        'ending_soon',
        'price_low',
        'price_high',
        'most_bids',
        'newest',
      ] as const) ?? 'ending_soon';

    const now = await this.prisma.dbNow();
    const statusesByPhase: Record<string, AuctionStatus[]> = {
      live: ['LIVE', 'SCHEDULED'],
      upcoming: ['SCHEDULED'],
      ended: ['ENDED', 'SOLD', 'UNSOLD'],
      any: PUBLIC_STATUSES.filter((s) => s !== 'CANCELLED'),
    };
    let categoryIds: string[] | undefined;
    if (category) {
      const root = await this.prisma.category.findUnique({
        where: { slug: category },
        select: { id: true, children: { select: { id: true } } },
      });
      categoryIds = root ? [root.id, ...root.children.map((c) => c.id)] : [];
    }
    const terms =
      query
        ?.split(/\s+/)
        .filter((t) => t.length > 1)
        .slice(0, 5) ?? [];
    const where: Prisma.AuctionWhereInput = {
      visibility: { not: 'PRIVATE' },
      status: { in: statusesByPhase[phase] },
      ...(phase === 'live'
        ? { startsAt: { lte: now }, endsAt: { gt: now } }
        : {}),
      ...(phase === 'upcoming' ? { startsAt: { gt: now } } : {}),
      ...(categoryIds ? { categoryId: { in: categoryIds } } : {}),
      ...(currency ? { currency } : {}),
      AND: terms.map((t) => ({
        OR: [
          { title: { contains: t, mode: 'insensitive' as const } },
          {
            vehicle: {
              is: { make: { contains: t, mode: 'insensitive' as const } },
            },
          },
          {
            vehicle: {
              is: { model: { contains: t, mode: 'insensitive' as const } },
            },
          },
          {
            watch: {
              is: { brand: { contains: t, mode: 'insensitive' as const } },
            },
          },
          {
            watch: {
              is: { model: { contains: t, mode: 'insensitive' as const } },
            },
          },
        ],
      })),
    };
    const rows = await this.prisma.auction.findMany({
      where,
      take: 60,
      orderBy:
        sort === 'newest'
          ? { createdAt: 'desc' }
          : sort === 'most_bids'
            ? { bidCount: 'desc' }
            : { endsAt: 'asc' },
      include: {
        category: { select: { name: true } },
        media: {
          orderBy: { position: 'asc' },
          take: 1,
          select: { url: true, variants: true },
        },
      },
    });
    const priceOf = (a: (typeof rows)[number]) =>
      a.currentPriceCents ?? a.startingPriceCents;
    const digitsOf = (c: string) =>
      SUPPORTED_CURRENCIES[c as keyof typeof SUPPORTED_CURRENCIES] ?? 2;
    let filtered = rows.filter((a) => {
      const major = Number(priceOf(a)) / 10 ** digitsOf(a.currency);
      return (
        (minPrice === undefined || major >= minPrice) &&
        (maxPrice === undefined || major <= maxPrice)
      );
    });
    if (sort === 'price_low')
      filtered.sort((a, b) => Number(priceOf(a) - priceOf(b)));
    if (sort === 'price_high')
      filtered.sort((a, b) => Number(priceOf(b) - priceOf(a)));
    filtered = filtered.slice(0, 8);
    const listings: ListingCard[] = filtered.map((a) => {
      const ph = phaseOf(a, now);
      return {
        id: a.id,
        title: a.title,
        category: a.category.name,
        phase: ph,
        price: money(priceOf(a), a.currency),
        formattedPrice: fmt(priceOf(a), a.currency),
        bidCount: a.bidCount,
        startsAt: a.startsAt.toISOString(),
        endsAt: a.endsAt.toISOString(),
        image: a.media[0] ? cardUrl(a.media[0]) : null,
        link: ph === 'live' ? `/room/${a.id}` : `/item/${a.id}`,
      };
    });
    return {
      output: {
        count: listings.length,
        note:
          listings.length === 0
            ? 'No matching auctions. Do not invent any; suggest broadening the search.'
            : 'These are the only matching listings. The user sees them as cards with links.',
        results: listings.map((l) => ({
          id: l.id,
          title: untrusted(l.title, 140),
          category: l.category,
          phase: l.phase,
          current_price: l.formattedPrice,
          bids: l.bidCount,
          ends_at: l.endsAt,
          time_left: timeLeft(l.endsAt),
          link: l.link,
        })),
      },
      listings,
    };
  }

  private async getAuction(args: Record<string, unknown>): Promise<ToolResult> {
    const id = uuid(args['auction_id'], 'auction_id');
    const a = await this.prisma.auction.findUnique({
      where: { id },
      include: {
        category: { select: { name: true } },
        seller: { select: { profile: { select: { handle: true } } } },
        vehicle: true,
        watch: true,
        media: {
          orderBy: { position: 'asc' },
          take: 1,
          select: { url: true, variants: true },
        },
      },
    });
    if (!a || a.visibility === 'PRIVATE' || !PUBLIC_STATUSES.includes(a.status))
      return { output: { error: 'Auction not found or not public.' } };
    const now = await this.prisma.dbNow();
    const ph = phaseOf(a, now);
    const price = a.currentPriceCents ?? a.startingPriceCents;
    const card: ListingCard = {
      id: a.id,
      title: a.title,
      category: a.category.name,
      phase: ph,
      price: money(price, a.currency),
      formattedPrice: fmt(price, a.currency),
      bidCount: a.bidCount,
      startsAt: a.startsAt.toISOString(),
      endsAt: a.endsAt.toISOString(),
      image: a.media[0] ? cardUrl(a.media[0]) : null,
      link: ph === 'live' ? `/room/${a.id}` : `/item/${a.id}`,
    };
    return {
      listings: [card],
      output: {
        id: a.id,
        lot_number: a.lotNumber,
        title: untrusted(a.title, 200),
        description: untrusted(a.description, 1200),
        category: a.category.name,
        status: a.status,
        phase: ph,
        condition: a.condition,
        seller: a.seller.profile?.handle ?? null,
        starting_price: fmt(a.startingPriceCents, a.currency),
        current_price:
          a.currentPriceCents === null
            ? null
            : fmt(a.currentPriceCents, a.currency),
        minimum_next_bid:
          ph === 'live' || ph === 'upcoming'
            ? fmt(minimumNextBid(a), a.currency)
            : null,
        min_increment: fmt(a.minIncrementCents, a.currency),
        reserve: reserveState(a), // none | met | not_met — the amount is never disclosed
        bid_count: a.bidCount,
        starts_at: a.startsAt.toISOString(),
        ends_at: a.endsAt.toISOString(),
        time_left: timeLeft(a.endsAt),
        anti_sniping: a.antiSnipingEnabled
          ? `Bids in the last ${a.antiSnipingWindowSec}s extend the end by ${a.antiSnipingExtensionSec}s`
          : 'off',
        vehicle: a.vehicle
          ? {
              make: a.vehicle.make,
              model: a.vehicle.model,
              year: a.vehicle.year,
              mileage_km: a.vehicle.mileageKm,
              transmission: a.vehicle.transmission,
            }
          : null,
        watch: a.watch
          ? {
              brand: a.watch.brand,
              model: a.watch.model,
              year: a.watch.year,
              box: a.watch.hasBox,
              papers: a.watch.hasPapers,
            }
          : null,
        link: card.link,
      },
    };
  }

  private async categories() {
    const rows = await this.prisma.category.findMany({
      where: { parentId: null, isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: {
        slug: true,
        name: true,
        children: { select: { name: true, slug: true } },
      },
    });
    const counts = await this.prisma.$queryRaw<
      { slug: string; live: number; upcoming: number }[]
    >`
      SELECT root.slug,
             count(a.id) FILTER (WHERE a.status = 'LIVE')::int AS live,
             count(a.id) FILTER (WHERE a.status = 'SCHEDULED')::int AS upcoming
      FROM categories root
      LEFT JOIN categories c ON c.id = root.id OR c."parentId" = root.id
      LEFT JOIN auctions a ON a."categoryId" = c.id AND a.visibility <> 'PRIVATE'
      WHERE root."parentId" IS NULL GROUP BY root.slug`;
    return rows.map((r) => ({
      ...r,
      ...(counts.find((c) => c.slug === r.slug) ?? { live: 0, upcoming: 0 }),
      link: `/explore?category=${encodeURIComponent(r.name)}`,
    }));
  }

  private async platformInfo(args: Record<string, unknown>) {
    const topic = oneOf(args['topic'], 'topic', TOPICS) ?? 'navigation';
    const bps = async (key: string) => {
      const row = await this.prisma.systemConfig.findUnique({ where: { key } });
      return typeof row?.value === 'number' ? row.value : 0;
    };
    switch (topic) {
      case 'bidding_rules':
        return {
          rules: [
            'You must be signed in with a verified email address to bid.',
            'The first bid must be at least the starting price; after that, at least the current price plus the minimum increment shown on the listing.',
            'You cannot bid on your own listing, and you cannot raise your own bid while you are already the highest bidder.',
            'Bids are final and binding once accepted; the server decides validity and ordering (first valid bid wins ties).',
            "Auctions end at the server's clock time; late bids are rejected. Some listings enable anti-sniping, which extends the end time when a bid arrives in the final window.",
            'If a reserve price is set and not met when the auction ends, the lot does not sell. The reserve amount itself is hidden.',
            'The AI assistant never places bids — use the Bid button in the auction room.',
          ],
        };
      case 'auction_statuses':
        return {
          statuses: {
            upcoming: 'Approved and scheduled; bidding has not started.',
            live: 'Bidding is open.',
            ended: 'Bidding closed; the result is being settled.',
            sold: 'Highest bid met the reserve (or there was none); the winner can complete the demo checkout.',
            unsold: 'No bids, or the reserve was not met.',
            cancelled:
              'Withdrawn by the seller before any bids, or cancelled by staff; all bids are void.',
            pending_review:
              'Submitted by a seller and waiting for staff approval (sellers only).',
          },
        };
      case 'fees':
        return {
          buyer_premium_percent: (await bps('fees.buyer_premium_bps')) / 100,
          seller_commission_percent:
            (await bps('fees.seller_commission_bps')) / 100,
          note: 'Fees come from platform configuration. Delivery options may add a shipping charge at checkout. AUCTRA is a demo: no real money is charged.',
        };
      case 'demo_checkout':
        return {
          summary:
            'AUCTRA is a portfolio demo marketplace. Checkout is simulated: no card details are collected and no real payment is made.',
          steps: [
            'When an auction you won ends, open it from Notifications, My bids or Orders.',
            'Review the final price and choose a delivery option.',
            'Confirm the simulated purchase. The order is marked "Demo Order Completed" and appears in Order history.',
          ],
        };
      case 'account_and_verification':
        return {
          points: [
            'After registering, verify your email with the 6-digit code or the link in the email (valid 15 minutes, single use).',
            'Request a new code from the verification screen if it expired; older codes stop working.',
            'Settings → Security shows active sessions; you can sign out other devices or everywhere, and change your password.',
            'Forgot your password? Use "Forgot password" on the sign-in page.',
          ],
        };
      case 'selling':
        return {
          steps: [
            'Apply to become a seller; staff review the application.',
            'Once approved, create a listing with photos, details, starting price and optional reserve.',
            'Listings are reviewed by staff before they are scheduled.',
            'Sellers can cancel only before the first bid.',
          ],
        };
      case 'chat_rules':
        return {
          rules: [
            'Each auction room has a public chat for signed-in, verified users.',
            'Messages are moderated; spam, harassment and sharing contact or payment details are not allowed.',
            'Moderators can hide messages and mute or ban users from chat; you can report messages from the message menu.',
          ],
        };
      default:
        return {
          pages: {
            '/live': 'Auctions with bidding open now',
            '/explore': 'Browse and filter all auctions',
            '/watchlist': 'Saved auctions',
            '/bids': 'My bids',
            '/orders': 'Order history (demo checkouts)',
            '/notifications': 'Notification center',
            '/settings': 'Profile, notification preferences, security',
            '/sell': 'Create a listing (approved sellers)',
            '/help': 'Help center',
          },
        };
    }
  }

  private async myBidding(auth: AuthContext) {
    const [bids, watch] = await Promise.all([
      this.prisma.bid.findMany({
        where: { bidderId: auth.userId },
        orderBy: { createdAt: 'desc' },
        distinct: ['auctionId'],
        take: 20,
        include: {
          auction: {
            select: {
              id: true,
              title: true,
              status: true,
              endsAt: true,
              currency: true,
              currentPriceCents: true,
              highestBid: { select: { bidderId: true } },
              winnerId: true,
            },
          },
        },
      }),
      this.prisma.watchlistItem.findMany({
        where: { userId: auth.userId },
        take: 20,
        include: {
          auction: {
            select: { id: true, title: true, status: true, endsAt: true },
          },
        },
      }),
    ]);
    return {
      bids: bids.map((b) => ({
        auction_id: b.auction.id,
        title: untrusted(b.auction.title, 140),
        status: b.auction.status,
        my_last_bid: fmt(b.amountCents, b.currency),
        current_price:
          b.auction.currentPriceCents === null
            ? null
            : fmt(b.auction.currentPriceCents, b.auction.currency),
        leading: b.auction.highestBid?.bidderId === auth.userId,
        won: b.auction.winnerId === auth.userId,
        ends_at: b.auction.endsAt.toISOString(),
        time_left: timeLeft(b.auction.endsAt),
        link: `/room/${b.auction.id}`,
      })),
      watchlist: watch.map((w) => ({
        auction_id: w.auction.id,
        title: untrusted(w.auction.title, 140),
        status: w.auction.status,
        ends_at: w.auction.endsAt.toISOString(),
        time_left: timeLeft(w.auction.endsAt),
      })),
    };
  }

  // ── admin tools

  private async analytics(args: Record<string, unknown>) {
    const a = await this.insights.analytics(
      num(args['days'], 'days', 7, 180) ?? 30,
    );
    return {
      period_days: a.periodDays,
      totals: a.totals,
      auction_status: a.auctionStatus,
      categories: a.categories,
      most_active_auctions: a.mostActiveAuctions.map((x) => ({
        ...x,
        title: untrusted(x.title, 140),
      })),
      demo_checkout: a.checkout,
      sales_volume: a.salesVolume,
    };
  }

  private async trends(args: Record<string, unknown>) {
    const a = await this.insights.analytics(
      num(args['days'], 'days', 7, 180) ?? 30,
    );
    return {
      bids_per_day: a.bidsOverTime,
      registrations_per_day: a.registrationsOverTime,
    };
  }

  private async moderation() {
    const [reports, restrictions, actions, disputes, awaitingReview] =
      await Promise.all([
        this.insights.reports(),
        this.prisma.chatRestriction.count({
          where: {
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
        }),
        this.prisma.moderationAction.findMany({
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            action: true,
            targetType: true,
            reason: true,
            createdAt: true,
          },
        }),
        this.prisma.dispute.findMany({
          where: { status: { in: ['OPEN', 'UNDER_REVIEW'] } },
          orderBy: { createdAt: 'asc' },
          take: 20,
          select: {
            id: true,
            status: true,
            reason: true,
            details: true,
            createdAt: true,
            order: {
              select: {
                orderNumber: true,
                auction: { select: { title: true } },
              },
            },
          },
        }),
        this.prisma.auction.count({ where: { status: 'PENDING_REVIEW' } }),
      ]);
    return {
      listings_awaiting_review: awaitingReview,
      open_disputes: disputes.map((d) => ({
        id: d.id,
        status: d.status,
        order_number: d.order.orderNumber,
        lot: untrusted(d.order.auction.title, 140),
        reason: untrusted(d.reason, 100),
        details: untrusted(d.details, 300),
        opened_at: d.createdAt,
      })),
      open_reports: reports.slice(0, 30).map((r) => ({
        id: r.id,
        target_type: r.targetType,
        target_id: r.targetId,
        reason: untrusted(r.reason, 100),
        details: untrusted(r.details, 300),
        reporter: r.reporter,
        created_at: r.createdAt,
        target: r.target
          ? {
              ...r.target,
              ...('body' in r.target
                ? { body: untrusted(r.target['body'] as string, 300) }
                : {}),
              ...('title' in r.target
                ? { title: untrusted(r.target['title'] as string, 140) }
                : {}),
            }
          : null,
      })),
      active_chat_restrictions: restrictions,
      recent_actions: actions.map((a) => ({
        ...a,
        reason: untrusted(a.reason, 200),
      })),
    };
  }

  private async searchUsers(args: Record<string, unknown>) {
    const r = await this.insights.users({
      q: str(args['query'], 'query', 80, { optional: true }),
      status: oneOf(args['status'], 'status', [
        'ACTIVE',
        'SUSPENDED',
        'BANNED',
      ] as const),
      role: oneOf(args['role'], 'role', [
        'USER',
        'SELLER',
        'MODERATOR',
        'ADMIN',
        'SUPER_ADMIN',
      ] as const),
      limit: 15,
    });
    // Emails are deliberately not sent to the model provider.
    return {
      total: r.total,
      users: r.items.map((u) => ({
        id: u.id,
        handle: u.handle,
        display_name: untrusted(u.displayName, 80),
        status: u.status,
        roles: u.roles,
        email_verified: u.emailVerified,
        bids: u.bids,
        listings: u.auctions,
        joined: u.createdAt,
      })),
    };
  }

  private async userActivity(args: Record<string, unknown>) {
    const u = await this.insights.user(uuid(args['user_id'], 'user_id'), {
      includeSessions: false,
    });
    return {
      id: u.id,
      handle: u.profile?.handle ?? null,
      status: u.status,
      suspension_reason: untrusted(u.suspensionReason, 200),
      roles: u.roles,
      email_verified: u.emailVerified,
      joined: u.createdAt,
      last_login: u.lastLoginAt,
      counts: u.counts,
      reports_against: u.reportsAgainst,
      chat_restriction: u.chatRestriction,
      recent_bids: u.recentBids.map((b) => ({
        ...b,
        auctionTitle: untrusted(b.auctionTitle, 120),
      })),
      recent_actions: u.activity.slice(0, 25).map((a) => ({
        action: a.action,
        at: a.createdAt,
        by_staff: !!a.actorId && a.actorId !== u.id,
      })),
      moderation_history: u.moderation,
    };
  }

  private async auctionPerformance(args: Record<string, unknown>) {
    const a = await this.insights.auction(
      uuid(args['auction_id'], 'auction_id'),
    );
    const bidders = new Set(a.bids.map((b) => b.bidder.id));
    return {
      id: a.id,
      title: untrusted(a.title, 200),
      status: a.status,
      category: a.category,
      seller: a.seller.handle,
      start_price: a.startPrice,
      price: a.price,
      reserve_set: a.reserve !== null,
      bid_count: a.bidCount,
      unique_bidders: bidders.size,
      starts_at: a.startsAt,
      ends_at: a.endsAt,
      winner: a.winner?.handle ?? null,
      order: a.order,
      bids: a.bids.slice(0, 60).map((b) => ({
        seq: b.sequence,
        bidder: b.bidder.handle,
        bidder_id: b.bidder.id,
        amount: b.amount,
        at: b.createdAt,
        network: b.network,
      })),
    };
  }

  private async propose(args: Record<string, unknown>): Promise<ToolResult> {
    const action = oneOf(args['action'], 'action', [
      'suspend_user',
      'ban_user',
      'mute_chat',
      'ban_chat',
      'hide_message',
      'cancel_auction',
    ] as const);
    if (!action) throw new ToolArgError('action is required');
    const targetId = uuid(args['target_id'], 'target_id');
    const reason = str(args['reason'], 'reason', 300)!;
    let targetLabel: string | null = null;
    let targetType: ProposedAction['targetType'];
    if (action === 'hide_message') {
      targetType = 'chat_message';
      const m = await this.prisma.auctionChatMessage.findUnique({
        where: { id: targetId },
        select: {
          body: true,
          author: { select: { profile: { select: { handle: true } } } },
        },
      });
      targetLabel = m
        ? `@${m.author.profile?.handle}: "${m.body.slice(0, 80)}"`
        : null;
    } else if (action === 'cancel_auction') {
      targetType = 'auction';
      const a = await this.prisma.auction.findUnique({
        where: { id: targetId },
        select: { title: true },
      });
      targetLabel = a?.title ?? null;
    } else {
      targetType = 'user';
      const p = await this.prisma.userProfile.findUnique({
        where: { userId: targetId },
        select: { handle: true },
      });
      targetLabel = p ? `@${p.handle}` : null;
    }
    if (!targetLabel)
      return {
        output: { error: `No ${targetType.replace('_', ' ')} with that id.` },
      };
    const proposal: ProposedAction = {
      action,
      targetType,
      targetId,
      targetLabel,
      reason,
    };
    return {
      proposal,
      output: {
        status: 'proposed_not_executed',
        message:
          'The proposal is shown to the administrator as a card. Nothing has been changed. Tell the admin they can review and confirm it.',
        proposal,
      },
    };
  }
}
