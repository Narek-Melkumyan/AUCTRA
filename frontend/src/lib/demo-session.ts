/**
 * DEMO MODE session + orders. Not authentication: a local profile so account pages
 * can be demonstrated. A real deployment replaces this with the backend's session API.
 */
import { useSyncExternalStore } from "react";

export type Profile = {
  name: string;
  email: string;
  handle: string;
  phone: string;
  country: string;
  emailAlerts: boolean;
  outbidAlerts: boolean;
  endingAlerts: boolean;
  /** API mode only. */
  id?: string;
  emailVerified?: boolean;
  roles?: string[];
  permissions?: string[];
};
export type OrderStatus =
  | "pending_payment"
  | "processing"
  | "shipped"
  | "delivered"
  | "completed"
  | "disputed"
  | "cancelled";
export type Order = {
  id: string;
  auctionId?: string;
  title: string;
  image?: string | undefined;
  hammer: number;
  status: OrderStatus;
  date: string;
  /** API mode: server total (major units) and currency; demo orders are always simulated. */
  total?: number;
  currency?: string;
  simulated?: boolean;
  orderId?: string;
};

/** `restored`: API mode has finished trying to restore the session from the refresh cookie. */
type S = { user: Profile | null; orders: Order[]; restored: boolean };
const IS_API_MODE = import.meta.env["VITE_API_MODE"] === "api";
const KEY = "auctra-demo-session";
const seedOrders: Order[] = [
  {
    id: "ORD-24081",
    title: "Vintage Chronograph, Panda Dial",
    hammer: 9800,
    status: "delivered",
    date: "2026-09-14",
  },
  {
    id: "ORD-24117",
    title: "Mid-Century Lounge Chair & Ottoman",
    hammer: 4200,
    status: "shipped",
    date: "2026-10-22",
  },
];
let state: S = { user: null, orders: IS_API_MODE ? [] : seedOrders, restored: !IS_API_MODE };
let loaded = false;
const ls = new Set<() => void>();
const save = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
};
const set = (fn: (s: S) => S) => {
  state = fn(state);
  save();
  ls.forEach((l) => l());
};
function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  if (IS_API_MODE) {
    // Restore the session from the HttpOnly refresh cookie (no tokens in localStorage).
    void import("./api/client")
      .then(async (c) => {
        if (await c.refreshSession()) {
          const me = c.lastRefreshedUser();
          if (me) await (await import("@/services/api")).loadSignedIn(me);
        }
      })
      .finally(() => setApiSession({ restored: true }));
    return;
  }
  try {
    const v = localStorage.getItem(KEY);
    if (v) state = { ...state, ...JSON.parse(v) };
  } catch {
    /* ignore */
  }
}
const sub = (l: () => void) => {
  load();
  ls.add(l);
  queueMicrotask(l);
  return () => {
    ls.delete(l);
  };
};
const server: S = state;
export function useSession<T>(sel: (s: S) => T): T {
  return useSyncExternalStore(
    sub,
    () => sel(state),
    () => sel(server),
  );
}

export function signIn(email: string, name?: string) {
  const n = name?.trim() || email.split("@")[0]!;
  set((s) => ({
    ...s,
    user: {
      name: n,
      email,
      handle: "you",
      phone: "",
      country: "United States",
      emailAlerts: true,
      outbidAlerts: true,
      endingAlerts: true,
    },
  }));
}
export const signOut = () => set((s) => ({ ...s, user: null }));
export const updateProfile = (p: Partial<Profile>) =>
  set((s) => (s.user ? { ...s, user: { ...s.user, ...p } } : s));
export function createOrder(o: Omit<Order, "id" | "date" | "status">): string {
  const existing = state.orders.find((x) => x.auctionId && x.auctionId === o.auctionId);
  if (existing) return existing.id;
  const id = `ORD-${Math.floor(25000 + Math.random() * 9000)}`;
  set((s) => ({
    ...s,
    orders: [
      { ...o, id, status: "processing", date: new Date().toISOString().slice(0, 10) },
      ...s.orders,
    ],
  }));
  return id;
}
export const orderStatusLabel: Record<OrderStatus, string> = {
  pending_payment: "Awaiting demo checkout",
  completed: "Demo order completed",
  processing: "Processing",
  shipped: "Shipped",
  delivered: "Delivered",
  disputed: "Dispute under review",
  cancelled: "Cancelled",
};

/** Non-hook read used by the service layer. */
export const getUser = () => state.user;

/** API mode: replaces the session with server data. Not persisted to localStorage. */
export function setApiSession(patch: Partial<S>) {
  state = { ...state, ...patch };
  ls.forEach((l) => l());
}
