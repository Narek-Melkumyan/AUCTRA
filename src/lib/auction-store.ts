/**
 * DEMO MODE auction store. Everything here is a local, client-side simulation used
 * only to demonstrate the interface. It is NOT authoritative auction state; a real
 * deployment replaces `tick` with server-pushed events (WebSocket) and `placeBid`
 * with a request to the server-authoritative auction engine.
 */
import { useSyncExternalStore } from "react";
import { seedAuctions, type Auction, type Bid, type ChatMsg, type Status } from "./auctions";

export type RoomState = Auction & {
  endsAt: number;
  startsAt: number;
  status: Status;
  bids: Bid[];
  chat: ChatMsg[];
  participants: string[];
  lastBidAt: number;
};

export type Notice = { id: string; kind: "outbid" | "leading" | "won" | "lost" | "ending"; auctionId: string; text: string; at: number; read: boolean };

type State = {
  demoStart: number;
  rooms: Record<string, RoomState>;
  watchlist: string[];
  notices: Notice[];
};

const handles = ["bidder_7f2", "arc_collector", "m.lauren", "g_hart", "vault_92", "kensington", "ny_buyer", "tokyo_k", "rivera", "orion_88", "bidder_c41", "salonbleu"];
const chatLines = ["Beautiful example.", "Any service records available?", "Reserve still not met?", "Watching closely 👀", "That patina is lovely.", "Is shipping to Canada possible?", "Great lot, good luck all.", "Price is still fair here."];
let uid = 0;
const id = () => `${Date.now().toString(36)}${(uid++).toString(36)}`;
const pick = <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)] as T;

function makeRooms(now: number): Record<string, RoomState> {
  const rooms: Record<string, RoomState> = {};
  for (const a of seedAuctions) {
    const startsAt = now + (a.startsInSec ?? 0) * 1000;
    const endsAt = a.startsInSec ? startsAt + a.durationSec * 1000 : now + a.durationSec * 1000;
    const bids: Bid[] = [];
    if (!a.startsInSec) {
      let amt = a.currentBid;
      for (let i = 0; i < 8 && amt > a.startBid; i++) {
        bids.push({ id: `${a.id}-s${i}`, user: handles[(i * 5 + a.id.length) % handles.length]!, amount: amt, at: now - (i + 1) * 47000 });
        amt -= a.increment * (1 + (i % 2));
      }
    }
    rooms[a.id] = {
      ...a,
      startsAt,
      endsAt,
      status: a.startsInSec ? "upcoming" : "live",
      bids,
      lastBidAt: bids[0]?.at ?? now,
      participants: handles.slice(0, 6 + (a.id.charCodeAt(4) % 6)),
      chat: [
        { id: `${a.id}-sys`, user: "AUCTRA", text: "Welcome to the room. This is a demo simulation — bids and timers are not real.", at: now - 300000, system: true },
        { id: `${a.id}-c1`, user: handles[2]!, text: "Looks stunning in person.", at: now - 120000 },
        { id: `${a.id}-c2`, user: "Moderator", text: "Please keep discussion related to this lot.", at: now - 60000, mod: true },
      ],
    };
  }
  return rooms;
}

const SERVER_EPOCH = 0;
let state: State = { demoStart: SERVER_EPOCH, rooms: makeRooms(SERVER_EPOCH), watchlist: ["a1002", "a1004"], notices: [] };
let initialized = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const set = (fn: (s: State) => State) => {
  state = fn(state);
  emit();
};

export const MY_HANDLE = "you";

function notify(n: Omit<Notice, "id" | "at" | "read">) {
  set((s) => ({ ...s, notices: [{ ...n, id: id(), at: Date.now(), read: false }, ...s.notices].slice(0, 40) }));
}

function tick() {
  const now = Date.now();
  const rooms = { ...state.rooms };
  const events: Array<() => void> = [];
  for (const r of Object.values(rooms)) {
    let room = r;
    if (room.status === "upcoming" && now >= room.startsAt) room = { ...room, status: "live" };
    if (room.status === "live" && now >= room.endsAt) {
      room = { ...room, status: "ended" };
      const top = room.bids[0];
      if (top?.mine) events.push(() => notify({ kind: "won", auctionId: room.id, text: `You won ${room.title}` }));
      else if (room.bids.some((b) => b.mine)) events.push(() => notify({ kind: "lost", auctionId: room.id, text: `Auction closed: ${room.title}` }));
    }
    if (room.status === "live") {
      const remaining = room.endsAt - now;
      const chance = remaining < 15000 ? 0.35 : 0.12;
      if (Math.random() < chance) {
        const amount = room.currentBid + room.increment * (Math.random() < 0.8 ? 1 : 2);
        const wasMine = room.bids[0]?.mine;
        const bid: Bid = { id: id(), user: pick(handles), amount, at: now };
        room = applyBid(room, bid, now);
        if (wasMine) events.push(() => notify({ kind: "outbid", auctionId: room.id, text: `You've been outbid on ${room.title}` }));
      }
      if (Math.random() < 0.06) {
        room = { ...room, chat: [...room.chat, { id: id(), user: pick(handles), text: pick(chatLines), at: now }].slice(-60) };
      }
      if (Math.random() < 0.2) {
        room = { ...room, viewers: Math.max(5, room.viewers + Math.round((Math.random() - 0.45) * 8)) };
      }
    }
    rooms[room.id] = room;
  }
  state = { ...state, rooms };
  emit();
  events.forEach((e) => e());
}

function applyBid(room: RoomState, bid: Bid, now: number): RoomState {
  // Soft-close: a bid within the final 10s extends the clock to 10s (demo rule).
  const endsAt = room.endsAt - now < 10000 ? now + 10000 : room.endsAt;
  const reserve = room.reserve === "not-met" && room.reservePrice && bid.amount >= room.reservePrice ? "met" : room.reserve;
  return { ...room, currentBid: bid.amount, bids: [bid, ...room.bids].slice(0, 80), lastBidAt: now, endsAt, reserve };
}

/** Validates a bid against the demo rules. Returns an error string or null. */
export function validateBid(room: Pick<RoomState, "status" | "currentBid" | "increment">, amount: number): string | null {
  if (room.status !== "live") return "This auction is not accepting bids.";
  if (!Number.isFinite(amount) || amount <= 0) return "Enter a valid amount.";
  const min = room.currentBid + room.increment;
  if (amount < min) return `Minimum next bid is $${min.toLocaleString("en-US")}.`;
  if ((amount - room.currentBid) % room.increment !== 0) return `Bids must be in $${room.increment.toLocaleString("en-US")} increments.`;
  return null;
}

export function placeBid(auctionId: string, amount: number): string | null {
  const room = state.rooms[auctionId];
  if (!room) return "Auction not found.";
  const err = validateBid(room, amount);
  if (err) return err;
  const now = Date.now();
  set((s) => ({ ...s, rooms: { ...s.rooms, [auctionId]: applyBid(room, { id: id(), user: MY_HANDLE, amount, at: now, mine: true }, now) } }));
  notify({ kind: "leading", auctionId, text: `You're the highest bidder on ${room.title}` });
  return null;
}

export function sendChat(auctionId: string, text: string) {
  const room = state.rooms[auctionId];
  if (!room || !text.trim()) return;
  set((s) => ({ ...s, rooms: { ...s.rooms, [auctionId]: { ...room, chat: [...room.chat, { id: id(), user: MY_HANDLE, text: text.trim(), at: Date.now() }] } } }));
}

export function toggleWatch(auctionId: string) {
  set((s) => ({ ...s, watchlist: s.watchlist.includes(auctionId) ? s.watchlist.filter((x) => x !== auctionId) : [...s.watchlist, auctionId] }));
}

export function markAllRead() {
  set((s) => ({ ...s, notices: s.notices.map((n) => ({ ...n, read: true })) }));
}

export function resetDemo() {
  const now = Date.now();
  set((s) => ({ ...s, demoStart: now, rooms: makeRooms(now), notices: [] }));
}

function init() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  const now = Date.now();
  state = { ...state, demoStart: now, rooms: makeRooms(now) };
  window.setInterval(tick, 1500);
}

function subscribe(l: () => void) {
  init();
  listeners.add(l);
  return () => listeners.delete(l);
}

const serverSnapshot = state;
export function useAuctionStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(serverSnapshot));
}

export const useRooms = () => useAuctionStore((s) => s.rooms);
export const useRoom = (id: string) => useAuctionStore((s) => s.rooms[id]);

/** Non-hook read used by the service layer. */
export const getRoomsSnapshot = () => state.rooms;
