/**
 * Real backend implementation of the service contracts (VITE_API_MODE=api).
 * Pages are unchanged: they keep calling `services.*` and reading the same stores.
 */
import { mutateStore, getRoomsSnapshot } from "@/lib/auction-store";
import { setApiSession, getUser } from "@/lib/demo-session";
import { askAssistant } from "@/lib/ai-mock";
import {
  ApiError,
  api,
  authCall,
  majorToMinor,
  setAccessToken,
  type AuthResponse,
} from "@/lib/api/client";
import { countryCode, toOrder, toProfile } from "@/lib/api/adapters";
import { rememberMyBid, follow } from "@/lib/api/live";
import type { BidDto, LiveState, MeDto, OrderDto } from "@/lib/api/types";
import type { Profile, Result, Services } from "./types";

const fail = (err: unknown, fallback: string): { ok: false; error: string } => ({
  ok: false,
  error: err instanceof ApiError ? err.message : fallback,
});

type Pref = { type: string; channel: string; enabled: boolean };

async function loadPrefs() {
  const prefs = await api<Pref[]>("/me/notifications/preferences").catch(() => [] as Pref[]);
  const on = (type: string, channel: string) =>
    prefs.find((p) => p.type === type && p.channel === channel)?.enabled ?? true;
  return {
    outbid: on("OUTBID", "IN_APP"),
    ending: on("AUCTION_ENDING_SOON", "IN_APP"),
    email: on("OUTBID", "EMAIL"),
  };
}

/** Loads profile + orders for the signed-in user into the session store. */
export async function loadSignedIn(me: MeDto): Promise<Profile> {
  const [prefs, orders] = await Promise.all([
    loadPrefs(),
    api<OrderDto[]>("/me/orders").catch(() => [] as OrderDto[]),
  ]);
  const profile = toProfile(me, prefs);
  setApiSession({ user: profile, orders: orders.filter((o) => o.role === "buyer").map(toOrder) });
  return profile;
}

async function completeAuth(r: AuthResponse): Promise<Result<Profile>> {
  setAccessToken(r.accessToken);
  return { ok: true, data: await loadSignedIn(r.user) };
}

/** Idempotency keys of bids whose outcome is still unknown (see placeBid). */
const pendingBidKeys = new Map<string, string>();

let lastRegistrationDelivery: "sent" | "failed" | "dev" | "" = "";
/** How the verification email of the last registration fared (for the confirmation screen). */
export const registrationDelivery = () => lastRegistrationDelivery;

export const apiServices: Services = {
  auth: {
    async signIn(email, password) {
      try {
        return await completeAuth(await authCall<AuthResponse>("/auth/login", { email, password }));
      } catch (err) {
        return fail(err, "Unable to sign in right now.");
      }
    },
    async register(name, email, password) {
      try {
        const r = await authCall<
          AuthResponse & {
            verificationEmail?: { delivered: boolean; providerConfigured: boolean };
          }
        >("/auth/register", { email, password, displayName: name });
        const v = r.verificationEmail;
        lastRegistrationDelivery = !v
          ? ""
          : v.delivered
            ? "sent"
            : v.providerConfigured
              ? "failed"
              : "dev";
        return await completeAuth(r);
      } catch (err) {
        if (err instanceof ApiError && err.code === "VALIDATION_FAILED") {
          const first = (err.details as { errors?: string[] } | undefined)?.errors?.[0];
          return { ok: false, error: first ?? err.message };
        }
        return fail(err, "Unable to create the account right now.");
      }
    },
    async signOut() {
      await authCall("/auth/logout").catch(() => undefined);
      setAccessToken(null);
      setApiSession({ user: null, orders: [] });
    },
    async updateProfile(patch) {
      try {
        const profile: Record<string, string> = {};
        if (patch.name !== undefined) profile["displayName"] = patch.name;
        if (patch.phone !== undefined) profile["phone"] = patch.phone;
        if (patch.country !== undefined) {
          const code = countryCode(patch.country);
          if (!code) return { ok: false, error: "Choose a supported country." };
          profile["country"] = code;
        }
        if (Object.keys(profile).length)
          await api<MeDto>("/me/profile", { method: "PATCH", body: profile });

        const prefs: Pref[] = [];
        if (patch.outbidAlerts !== undefined)
          prefs.push({ type: "OUTBID", channel: "IN_APP", enabled: patch.outbidAlerts });
        if (patch.endingAlerts !== undefined)
          prefs.push({
            type: "AUCTION_ENDING_SOON",
            channel: "IN_APP",
            enabled: patch.endingAlerts,
          });
        if (patch.emailAlerts !== undefined) {
          for (const type of [
            "OUTBID",
            "AUCTION_WON",
            "AUCTION_ENDING_SOON",
            "AUCTION_REMINDER",
            "ORDER_UPDATE",
          ]) {
            prefs.push({ type, channel: "EMAIL", enabled: patch.emailAlerts });
          }
        }
        if (prefs.length)
          await api("/me/notifications/preferences", {
            method: "PUT",
            body: { preferences: prefs },
          });
        const user = getUser();
        if (user) setApiSession({ user: { ...user, ...patch } });
        return { ok: true, data: undefined };
      } catch (err) {
        return fail(err, "Could not save your settings.");
      }
    },
  },
  auctions: {
    async list() {
      return Object.values(getRoomsSnapshot());
    },
    async get(id) {
      follow(id);
      return getRoomsSnapshot()[id] ?? null;
    },
    async toggleWatch(id) {
      const watching = (await import("@/lib/auction-store")).getWatchlistSnapshot().includes(id);
      // Optimistic update, reverted if the server refuses.
      const apply = (on: boolean) =>
        mutateStore((s) => ({
          ...s,
          watchlist: on ? [...new Set([...s.watchlist, id])] : s.watchlist.filter((x) => x !== id),
        }));
      apply(!watching);
      try {
        await api(
          `/me/watchlist/${id}`,
          watching ? { method: "DELETE" } : { method: "PUT", body: {} },
        );
      } catch (err) {
        apply(watching);
        throw err;
      }
    },
  },
  bidding: {
    async placeBid(auctionId, amount) {
      const room = getRoomsSnapshot()[auctionId];
      const currency = room?.currency ?? "USD";
      const amountMinor = majorToMinor(amount, currency);
      // One idempotency key per LOGICAL bid. It is reused for automatic retries and for
      // a manual retry after a network/server failure, so the server can never record
      // the same intended bid twice; it is discarded once the server gave an answer.
      const slot = `${auctionId}:${amountMinor}`;
      const key = pendingBidKeys.get(slot) ?? crypto.randomUUID();
      pendingBidKeys.set(slot, key);
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await api<{ bid: BidDto; auction: LiveState }>(
            `/auctions/${auctionId}/bids`,
            {
              method: "POST",
              headers: { "Idempotency-Key": key },
              body: { amountMinor, currency },
            },
          );
          pendingBidKeys.delete(slot);
          rememberMyBid(auctionId, res.bid, res.auction);
          return { ok: true, data: undefined };
        } catch (err) {
          const busy = err instanceof ApiError && err.status === 503;
          const network = !(err instanceof ApiError);
          if ((busy || network) && attempt < 2) {
            const wait = busy
              ? ((err.details as { retryAfterMs?: number } | undefined)?.retryAfterMs ?? 500)
              : 400;
            await new Promise((r) => setTimeout(r, wait * (attempt + 1)));
            continue;
          }
          if (busy || network || (err instanceof ApiError && err.status >= 500)) {
            // Outcome unknown or not decided: keep the key so "Bid again" is a safe retry.
            return {
              ok: false,
              error: network
                ? "Connection problem — your bid may not have reached us. Press Bid again to retry safely."
                : "The auction is very busy and your bid was not placed. Please retry.",
            };
          }
          pendingBidKeys.delete(slot);
          if (err instanceof ApiError && err.status === 401)
            return { ok: false, error: "Sign in to place a bid." };
          return fail(err, "Bid could not be submitted. Please try again.");
        }
      }
    },
    async sendChat() {
      // Room chat has no server implementation yet; nothing is sent.
    },
  },
  orders: {
    async createFromWin(input) {
      // Orders are created by the server when the auction settles; look it up.
      try {
        const orders = await api<OrderDto[]>(
          `/me/orders?auctionId=${encodeURIComponent(input.auctionId)}`,
        );
        const order = orders.find((o) => o.role === "buyer");
        if (!order)
          return { ok: false, error: "Your order is still being prepared. Try again in a moment." };
        const all = await api<OrderDto[]>("/me/orders");
        setApiSession({ orders: all.filter((o) => o.role === "buyer").map(toOrder) });
        return { ok: true, data: { orderId: order.orderNumber } };
      } catch (err) {
        return fail(err, "Couldn't load your order.");
      }
    },
  },
  ai: {
    async ask(q, rooms, ctx) {
      // The assistant is still the local, read-only mock: it never places bids.
      return askAssistant(q, rooms, ctx);
    },
  },
};

export async function markAllNoticesRead() {
  mutateStore((s) => ({
    ...s,
    notices: s.notices.map((n) => ({ ...n, read: true })),
    noticeUnread: 0,
  }));
  await api("/me/notifications/read-all", { method: "POST" }).catch(() => undefined);
}

export async function markNoticeRead(id: string) {
  let changed = false;
  mutateStore((s) => {
    const n = s.notices.find((x) => x.id === id);
    if (!n || n.read) return s;
    changed = true;
    return {
      ...s,
      notices: s.notices.map((x) => (x.id === id ? { ...x, read: true } : x)),
      noticeUnread: Math.max(0, (s.noticeUnread ?? 1) - 1),
    };
  });
  if (changed) await api(`/me/notifications/${id}/read`, { method: "POST" }).catch(() => undefined);
}

export type NotificationPage = {
  items: import("@/lib/api/types").NotificationDto[];
  unread: number;
  hasMore: boolean;
};

/** One page of notification history (newest first). */
export function loadNotificationPage(opts: {
  before?: string;
  types?: string[];
  unreadOnly?: boolean;
}) {
  const q = new URLSearchParams({ limit: "30" });
  if (opts.before) q.set("before", opts.before);
  if (opts.types?.length) q.set("types", opts.types.join(","));
  if (opts.unreadOnly) q.set("unreadOnly", "true");
  return api<NotificationPage>(`/me/notifications?${q.toString()}`);
}

export type PreferenceRow = {
  type: string;
  channel: "IN_APP" | "EMAIL";
  enabled: boolean;
  locked: boolean;
};
export const loadPreferences = () => api<PreferenceRow[]>("/me/notifications/preferences");
export const savePreferences = (preferences: Omit<PreferenceRow, "locked">[]) =>
  api<PreferenceRow[]>("/me/notifications/preferences", {
    method: "PUT",
    body: { preferences },
  });

type Outcome = { ok: true } | { ok: false; error: string };

export async function resetPassword(token: string, newPassword: string): Promise<Outcome> {
  try {
    await api("/auth/reset-password", { method: "POST", body: { token, newPassword } });
    return { ok: true };
  } catch (err) {
    if (err instanceof ApiError && err.code === "VALIDATION_FAILED") {
      return { ok: false, error: "Password must be at least 10 characters." };
    }
    return fail(err, "Could not reset the password.");
  }
}

/** Always resolves with the same message: the API never reveals whether the email exists. */
export async function requestPasswordReset(email: string): Promise<string> {
  await api("/auth/forgot-password", { method: "POST", body: { email } }).catch(() => undefined);
  return "If an account exists for that email, a reset link has been sent.";
}

/** Reloads the signed-in buyer's orders into the session (after checkout or a dispute). */
export async function reloadOrders() {
  const all = await api<OrderDto[]>("/me/orders");
  setApiSession({ orders: all.filter((o) => o.role === "buyer").map(toOrder) });
}

/** Opens a dispute on one of my orders; staff handle it in the admin console. */
export async function openDispute(orderId: string, reason: string, details?: string) {
  await api(`/orders/${orderId}/disputes`, {
    method: "POST",
    body: { reason, ...(details ? { details } : {}) },
  });
  await reloadOrders().catch(() => undefined);
}

/** Reports a listing to the moderation queue. */
export async function reportListing(auctionId: string, reason: string, details?: string) {
  await api("/reports", {
    method: "POST",
    body: { targetType: "AUCTION", targetId: auctionId, reason, ...(details ? { details } : {}) },
  });
}
