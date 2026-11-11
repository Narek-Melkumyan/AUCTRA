/**
 * Service contracts the UI depends on. The demo implementations (./demo) wrap the
 * local simulation; a backend implementation (Express REST + Socket.IO) must satisfy
 * the same interfaces so pages never change.
 */
import type { RoomState } from "@/lib/auction-store";
import type { Order, Profile } from "@/lib/demo-session";
import type { AiReply } from "@/lib/ai-mock";

export type { RoomState, Order, Profile, AiReply };

/** Result of a mutating call. `error` is a user-readable message. */
export type Result<T = void> = { ok: true; data: T } | { ok: false; error: string };

export interface AuthService {
  signIn(email: string, password: string): Promise<Result<Profile>>;
  register(name: string, email: string, password: string): Promise<Result<Profile>>;
  signOut(): Promise<void>;
  updateProfile(patch: Partial<Profile>): Promise<Result>;
}

export interface AuctionService {
  list(): Promise<RoomState[]>;
  get(id: string): Promise<RoomState | null>;
  toggleWatch(id: string): Promise<void>;
}

/** Server is authoritative: the client only requests a bid; the engine accepts or rejects it. */
export interface BiddingService {
  placeBid(auctionId: string, amount: number): Promise<Result>;
  sendChat(auctionId: string, text: string): Promise<void>;
}

export interface OrderService {
  createFromWin(input: { auctionId: string; title: string; image?: string | undefined; hammer: number }): Promise<Result<{ orderId: string }>>;
}

/** AI must never place bids or take account actions. */
export interface AiService {
  ask(question: string, rooms: RoomState[], context?: RoomState): Promise<AiReply>;
}

export type Services = { auth: AuthService; auctions: AuctionService; bidding: BiddingService; orders: OrderService; ai: AiService };
