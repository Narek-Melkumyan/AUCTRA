/**
 * Server-authoritative replacement for the demo auction simulation (VITE_API_MODE=api).
 *
 * - Hydrates the store from REST, then follows auctions over Socket.IO.
 * - Every realtime event carries the auction `version`. Events at or below the version
 *   we hold are ignored (duplicates / out of order); a jump of more than one triggers a
 *   resync (`auction:sync`) because an event was missed.
 * - On (re)connect every followed room is re-joined, and the join acknowledgement
 *   carries a fresh snapshot — that is the reconnection recovery path.
 * - Nothing here decides whether a bid is valid; the server does.
 */
import { io, type Socket } from "socket.io-client";
import { mutateStore, getRoomsSnapshot, type RoomState } from "@/lib/auction-store";
import { api, getAccessToken, onAccessToken, refreshSession, SOCKET_URL } from "./client";
import { applyLiveState, setClockOffset, toBid, toNotice, toRoom, syncClock } from "./adapters";
import { minorToMajor } from "./client";
import type { AuctionDto, BidDto, LiveState, MyBidDto, NotificationDto } from "./types";

const MAX_FOLLOWED = 25;
const REFRESH_LIST_MS = 30_000;

let socket: Socket | null = null;
type Handler = (payload: unknown) => void;
/** Subscribers to raw socket events (e.g. chat), independent of when the socket is created. */
const handlers = new Map<string, Set<Handler>>();

/** Subscribe to a socket event ("chat:message", "chat:update", or "connect" for (re)connects). */
export function onSocketEvent(name: string, handler: Handler): () => void {
  let set = handlers.get(name);
  if (!set) handlers.set(name, (set = new Set()));
  set.add(handler);
  return () => set.delete(handler);
}
const dispatch = (name: string, payload?: unknown) =>
  handlers.get(name)?.forEach((h) => {
    try {
      h(payload);
    } catch (err) {
      console.error(err);
    }
  });
let started = false;
const followed = new Set<string>();
/** My pseudonym per auction, learned from my own bids, so broadcasts can be marked "mine". */
const myAliases = new Map<string, string>();

type JoinAck =
  | { ok: true; auction: AuctionDto; bids: BidDto[]; viewers: number }
  | { ok: false; error: { code: string; message: string } };
type BidEvent = {
  eventId: string;
  auctionId: string;
  version: number;
  bid: BidDto;
  state: LiveState;
};
type StateEvent = {
  eventId: string;
  auctionId: string;
  version: number;
  type: string;
  state: LiveState;
};

export function startLiveSync() {
  if (started || typeof window === "undefined") return;
  started = true;
  void hydrate();
  connectSocket();
  // Reconnect with the new identity whenever the user signs in/out or the token rotates.
  let lastToken = getAccessToken();
  onAccessToken((token) => {
    const identityChanged = Boolean(token) !== Boolean(lastToken);
    lastToken = token;
    if (socket) socket.auth = { token: token ?? "" };
    if (identityChanged) {
      socket?.disconnect().connect();
      void hydrate();
    } else if (token && socket?.connected) {
      // Same user, rotated token: re-authenticate in place (rooms stay joined).
      socket.emit("auth:refresh", { token });
    }
  });
  window.setInterval(() => void hydrate(), REFRESH_LIST_MS);
}

/** Loads listings (and, when signed in, my bids, watchlist and notifications). */
export async function hydrate() {
  try {
    // Live and upcoming lots are what the home page, rooms and countdowns need. Ended lots
    // are loaded on demand (Explore, item pages) so a large archive never crowds them out.
    const [livePage, upcomingPage] = await Promise.all([
      api<{ items: AuctionDto[]; serverTime: string }>(
        "/auctions?phase=live&sort=ending_soon&limit=100",
      ),
      api<{ items: AuctionDto[]; serverTime: string }>(
        "/auctions?phase=upcoming&sort=ending_soon&limit=60",
      ),
    ]);
    const page = { ...livePage, items: [...livePage.items, ...upcomingPage.items] };
    syncClock(page.serverTime);
    const signedIn = Boolean(getAccessToken());
    const [mine, watch, notes] = signedIn
      ? await Promise.all([
          api<MyBidDto[]>("/me/bids").catch(() => []),
          api<{ auctionId: string }[]>("/me/watchlist").catch(() => []),
          api<{ items: NotificationDto[]; unread: number }>("/me/notifications").catch(() => ({
            items: [] as NotificationDto[],
            unread: 0,
          })),
        ])
      : [[], [], { items: [] as NotificationDto[], unread: 0 }];
    // Lots I bid on or watch that are not in the first page (e.g. older, ended ones) are
    // loaded individually so My bids, the dashboard and the watchlist are complete.
    const listed = new Set(page.items.map((a) => a.id));
    const missing = [
      ...new Set([...mine.map((m) => m.auctionId), ...watch.map((w) => w.auctionId)]),
    ]
      .filter((id) => !listed.has(id))
      .slice(0, 50);
    if (missing.length) {
      const extra = await Promise.allSettled(
        missing.map((id) => api<AuctionDto>(`/auctions/${id}`)),
      );
      for (const r of extra) if (r.status === "fulfilled") page.items.push(r.value);
    }
    mutateStore((s) => {
      // Keep lots opened on demand (item/room pages, older lots) while they are followed.
      const rooms: Record<string, RoomState> = {};
      for (const id of followed) if (s.rooms[id]) rooms[id] = s.rooms[id];
      for (const a of page.items) {
        const prev = s.rooms[a.id];
        // Keep full histories loaded by a room join; otherwise build from the listing.
        let room = toRoom(a, null, prev && (prev.version ?? 0) <= a.version ? prev : undefined);
        if (prev && (prev.version ?? 0) <= a.version) room = { ...room, bids: prev.bids };
        const my = mine.find((m) => m.auctionId === a.id);
        if (my && !room.bids.some((b) => b.mine)) {
          // Mark that I bid here (for My Bids / dashboard) without inventing history.
          const amount = minorToMajor(my.myHighestBid.minor, my.myHighestBid.currency);
          room = {
            ...room,
            bids: [
              ...room.bids,
              {
                id: `mine-${a.id}`,
                user: "you",
                amount,
                at: Date.parse(my.lastBidAt ?? a.startsAt),
                mine: true,
              },
            ].sort((x, y) => y.amount - x.amount),
          };
        }
        rooms[a.id] = room;
      }
      return {
        ...s,
        rooms,
        ...(signedIn
          ? {
              watchlist: watch.map((w) => w.auctionId),
              notices: notes.items.map(toNotice),
              noticeUnread: notes.unread,
            }
          : { watchlist: [], notices: [], noticeUnread: 0 }),
      };
    });
    // Follow live and upcoming auctions, soonest-ending first.
    const interesting = page.items
      .filter((a) => a.phase === "live" || a.phase === "upcoming")
      .slice(0, MAX_FOLLOWED);
    for (const a of interesting) follow(a.id);
  } catch (err) {
    console.warn("AUCTRA: could not load auctions from the API", err);
  }
}

function connectSocket() {
  socket = io(SOCKET_URL, {
    path: "/socket.io",
    transports: ["websocket"],
    auth: { token: getAccessToken() ?? "" },
    reconnectionDelayMax: 10_000,
  });
  socket.on("connect", () => {
    for (const id of followed) void join(id);
    void measureClock();
    dispatch("connect");
  });
  // Server heartbeat with the authoritative version: catches events we never received
  // (e.g. a cross-instance publish lost during a Redis outage) even in a quiet room.
  socket.on("auction:tick", (e: { auctionId: string; version: number }) => {
    const room = getRoomsSnapshot()[e.auctionId];
    if (room && e.version > (room.version ?? 0)) void join(e.auctionId, "auction:sync");
  });
  // The server stopped trusting this connection's token (expired or session revoked).
  socket.on("auth:expired", () => {
    void refreshSession().then((ok) => {
      const token = getAccessToken();
      if (ok && token) socket?.emit("auth:refresh", { token });
    });
  });
  socket.on("chat:message", (e: unknown) => dispatch("chat:message", e));
  socket.on("chat:update", (e: unknown) => dispatch("chat:update", e));
  // Private buyer–seller messages (delivered only to the participants' user rooms).
  socket.on("message", (e: unknown) => dispatch("message", e));
  socket.on("auction:bid", (e: BidEvent) => applyBidEvent(e));
  socket.on("auction:state", (e: StateEvent) => applyStateEvent(e));
  socket.on("notification", (n: NotificationDto) => {
    let fresh = false;
    mutateStore((s) => {
      if (s.notices.some((x) => x.id === n.id)) return s;
      fresh = true;
      return {
        ...s,
        notices: [toNotice(n), ...s.notices].slice(0, 100),
        noticeUnread: (s.noticeUnread ?? 0) + (n.read ? 0 : 1),
      };
    });
    if (fresh) dispatch("notification", n);
  });
}

export function follow(id: string) {
  if (followed.has(id)) return;
  if (followed.size >= MAX_FOLLOWED) {
    const oldest = followed.values().next().value;
    if (oldest) {
      followed.delete(oldest);
      socket?.emit("auction:leave", { auctionId: oldest });
    }
  }
  followed.add(id);
  if (socket?.connected) void join(id);
}

async function join(id: string, event: "auction:join" | "auction:sync" = "auction:join") {
  if (!socket) return;
  const ack = (await socket
    .timeout(10_000)
    .emitWithAck(event, { auctionId: id })
    .catch(() => null)) as JoinAck | null;
  if (!ack || !ack.ok) return;
  for (const b of ack.bids) if (b.mine) myAliases.set(id, b.bidderAlias);
  mutateStore((s) => {
    const prev = s.rooms[id];
    // Never let an older snapshot overwrite newer state applied from a live event.
    if (prev && (prev.version ?? 0) > ack.auction.version) return s;
    const room = toRoom(ack.auction, ack.bids, prev);
    return { ...s, rooms: { ...s.rooms, [id]: { ...room, viewers: Math.max(ack.viewers, 1) } } };
  });
}

/** Records the pseudonym the server assigned to my bid (from the POST /bids response). */
export function rememberMyBid(auctionId: string, bid: BidDto, state: LiveState) {
  myAliases.set(auctionId, bid.bidderAlias);
  applyBidEvent({
    eventId: "local",
    auctionId,
    version: state.version,
    bid: { ...bid, mine: true },
    state,
  });
}

/**
 * The ordering rule for versioned auction events: apply exactly the next version,
 * ignore duplicates/older ones, and resync from the server on a gap.
 */
export function eventAction(held: number, incoming: number): "apply" | "ignore" | "resync" {
  if (incoming <= held) return "ignore";
  return incoming === held + 1 ? "apply" : "resync";
}

function applyBidEvent(e: BidEvent) {
  const room = getRoomsSnapshot()[e.auctionId];
  if (!room) return;
  const action = eventAction(room.version ?? 0, e.version);
  if (action === "ignore") return; // duplicate or stale
  if (action === "resync") {
    void join(e.auctionId, "auction:sync"); // missed something: resync from the server
    return;
  }
  const mine = e.bid.mine || myAliases.get(e.auctionId) === e.bid.bidderAlias;
  mutateStore((s) => {
    const r = s.rooms[e.auctionId];
    if (!r) return s;
    const next = applyLiveState(r, e.state, r.currency ?? e.bid.amount.currency);
    const bid = toBid(e.bid, mine);
    const bids = [
      bid,
      ...r.bids.filter(
        (b) => b.id !== bid.id && !b.id.startsWith("top-") && !b.id.startsWith("mine-"),
      ),
    ].slice(0, 80);
    return {
      ...s,
      rooms: {
        ...s.rooms,
        [e.auctionId]: {
          ...next,
          bids,
          lastBidAt: bid.at,
          participants: [...new Set(bids.map((b) => b.user))],
        },
      },
    };
  });
}

function applyStateEvent(e: StateEvent) {
  const room = getRoomsSnapshot()[e.auctionId];
  if (!room) return;
  const action = eventAction(room.version ?? 0, e.version);
  if (action === "ignore") return;
  if (action === "resync") {
    void join(e.auctionId, "auction:sync");
    return;
  }
  mutateStore((s) => {
    const r = s.rooms[e.auctionId];
    return r
      ? {
          ...s,
          rooms: { ...s.rooms, [e.auctionId]: applyLiveState(r, e.state, r.currency ?? "USD") },
        }
      : s;
  });
  // Settlement outcome (winner, hammer price) is part of the full auction view.
  if (e.type === "auction.sold" || e.type === "auction.unsold" || e.type === "auction.cancelled") {
    void join(e.auctionId, "auction:sync");
  }
}

/**
 * NTP-style clock sync over the socket: three round trips, keep the one with the
 * smallest RTT, offset = serverTime + rtt/2 − receiveTime. Countdowns use this offset;
 * the server remains the only authority on deadlines.
 */
export async function measureClock(samples = 3): Promise<number | null> {
  if (!socket?.connected) return null;
  let best: { rtt: number; offset: number } | null = null;
  for (let i = 0; i < samples; i++) {
    const t0 = Date.now();
    const ack = (await socket
      .timeout(5_000)
      .emitWithAck("time:sync", { clientTime: t0 })
      .catch(() => null)) as { ok: boolean; serverTime: string } | null;
    const t1 = Date.now();
    if (!ack?.ok) continue;
    const rtt = t1 - t0;
    const offset = Date.parse(ack.serverTime) + rtt / 2 - t1;
    if (!best || rtt < best.rtt) best = { rtt, offset };
  }
  if (best) setClockOffset(best.offset);
  return best?.offset ?? null;
}

/** Item/room pages: make sure this lot is loaded and live-synced even if it is not in the
 * home-page set (e.g. an ended lot or one deep in the catalogue). */
export function ensureRoom(id: string) {
  follow(id);
}
