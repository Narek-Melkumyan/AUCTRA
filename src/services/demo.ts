/** DEMO implementations — local only, no network, no real money or accounts. */
import * as store from "@/lib/auction-store";
import * as session from "@/lib/demo-session";
import { askAssistant } from "@/lib/ai-mock";
import type { Services } from "./types";

const snapshot = () => Object.values(store.getRoomsSnapshot());
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const demoServices: Services = {
  auth: {
    async signIn(email) { session.signIn(email); return { ok: true, data: session.getUser()! }; },
    async register(name, email) { session.signIn(email, name); return { ok: true, data: session.getUser()! }; },
    async signOut() { session.signOut(); },
    async updateProfile(p) { session.updateProfile(p); return { ok: true, data: undefined }; },
  },
  auctions: {
    async list() { return snapshot(); },
    async get(id) { return store.getRoomsSnapshot()[id] ?? null; },
    async toggleWatch(id) { store.toggleWatch(id); },
  },
  bidding: {
    async placeBid(id, amount) { const e = store.placeBid(id, amount); return e ? { ok: false, error: e } : { ok: true, data: undefined }; },
    async sendChat(id, text) { store.sendChat(id, text); },
  },
  orders: {
    async createFromWin(i) { return { ok: true, data: { orderId: session.createOrder(i) } }; },
  },
  ai: {
    async ask(q, rooms, ctx) { await wait(700); return askAssistant(q, rooms, ctx); },
  },
};
