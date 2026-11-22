import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { AccessTokenService } from '../auth/access-token.service.js';
import { RealtimeSessions } from '../auth/realtime-sessions.js';
import { AuctionsService } from '../auctions/auctions.service.js';
import { BidsService } from '../bids/bids.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthContext } from '../common/auth-context.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { AppConfig } from '../config/app-config.js';
import { Permission } from '../roles/permissions.js';
import type { AuctionDto } from '../auctions/auction.mapper.js';
import type { BidDto } from '../bids/bids.service.js';

export const auctionRoom = (id: string) => `auction:${id}`;
export const userRoom = (id: string) => `user:${id}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ROOMS_PER_SOCKET = 25;
const BUCKET_CAPACITY = 20;
const BUCKET_REFILL_PER_SEC = 2;
/** Public snapshots are shared by all anonymous joins of a room for this long. */
const SNAPSHOT_TTL_MS = 1_000;
/** How often connected sessions are re-validated (revocations, bans, expiry). */
const AUTH_SWEEP_MS = 30_000;
/** Grace after access-token expiry before a socket is downgraded to anonymous. */
const TOKEN_GRACE_MS = 60_000;

type Snapshot = {
  auction: AuctionDto;
  bids: BidDto[];
};

type Ack<T> =
  ({ ok: true } & T) | { ok: false; error: { code: string; message: string } };

interface SocketData {
  auth?: AuthContext;
  authError?: string;
  /** Access-token expiry (epoch ms). */
  tokenExp?: number;
  tokens: number;
  refilledAt: number;
  strikes: number;
}

/**
 * Realtime auction rooms.
 *
 * Client → server (all acknowledged):
 *   auction:join  { auctionId }  → { ok, auction, bids, serverTime }
 *   auction:sync  { auctionId }  → same payload; call after reconnect or on a version gap
 *   auction:leave { auctionId }  → { ok }
 *   time:sync     {}             → { ok, serverTime }
 *
 * Server → client:
 *   auction:bid    { eventId, auctionId, version, bid, state }
 *   auction:state  { eventId, auctionId, version, type, state }
 *   notification   (private, only to the signed-in owner)
 *
 * Bids are placed over HTTPS (POST /api/auctions/:id/bids) so they share the HTTP
 * idempotency, rate limiting and error contract; sockets are read-only broadcast.
 * Events carry the auction `version`: clients drop events with version ≤ the one they
 * hold and resync when they see a gap.
 */
@WebSocketGateway()
export class AuctionsGateway
  implements OnGatewayInit, OnModuleInit, OnModuleDestroy
{
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(AuctionsGateway.name);
  /** Per-instance read-side cache of public room snapshots (with in-flight dedupe). */
  private readonly snapshots = new Map<
    string,
    { at: number; promise: Promise<Snapshot> }
  >();
  /** DB clock minus local clock, refreshed periodically (time:sync never hits the DB). */
  private clockOffsetMs = 0;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly tokens: AccessTokenService,
    private readonly auctions: AuctionsService,
    private readonly bids: BidsService,
    private readonly prisma: PrismaService,
    private readonly realtimeSessions: RealtimeSessions,
    private readonly metrics: MetricsService,
    private readonly config: AppConfig,
  ) {}

  onModuleInit() {
    this.realtimeSessions.register((userId) =>
      this.server?.in(userRoom(userId)).disconnectSockets(true),
    );
    void this.syncDbClock();
    this.timers.push(
      setInterval(() => void this.syncDbClock(), 30_000),
      setInterval(() => void this.sweepSessions(), AUTH_SWEEP_MS),
    );
    for (const t of this.timers) t.unref();
  }

  onModuleDestroy() {
    for (const t of this.timers) clearInterval(t);
  }

  /**
   * Called by the outbox relay when an auction changed: drop the cached snapshot here
   * and on every other instance (the relay runs on only one of them). If the message is
   * lost (Redis outage), staleness is still bounded by SNAPSHOT_TTL_MS.
   */
  invalidate(auctionId: string) {
    this.snapshots.delete(auctionId);
    if (!this.config.redisUrl || !this.server) return;
    try {
      this.server.serverSideEmit('auction:invalidate', auctionId);
    } catch {
      /* best effort; TTL bounds staleness */
    }
  }

  /** Authoritative (database) time estimated from the local clock and a measured offset. */
  dbTime(): Date {
    return new Date(Date.now() + this.clockOffsetMs);
  }

  private async syncDbClock() {
    try {
      const t0 = Date.now();
      const db = await this.prisma.dbNow();
      const t1 = Date.now();
      this.clockOffsetMs = db.getTime() - (t0 + t1) / 2;
    } catch {
      /* keep the last offset */
    }
  }

  /**
   * Re-validates authenticated sockets: revoked/expired sessions and banned or
   * suspended users lose their user room (private notifications) and are told to
   * re-authenticate; sockets whose access token expired get a grace period to send
   * `auth:refresh`. One query per instance per sweep.
   */
  async sweepSessions(): Promise<number> {
    if (!this.server) return 0;
    const sockets = [...this.server.of('/').sockets.values()].filter(
      (s) => (s.data as SocketData).auth,
    );
    if (!sockets.length) return 0;
    const sids = [
      ...new Set(sockets.map((s) => (s.data as SocketData).auth!.sessionId)),
    ];
    const valid = new Set(
      (
        await this.prisma.session.findMany({
          where: {
            id: { in: sids },
            revokedAt: null,
            expiresAt: { gt: new Date() },
            user: { status: 'ACTIVE', deletedAt: null },
          },
          select: { id: true },
        })
      ).map((r) => r.id),
    );
    let downgraded = 0;
    const now = Date.now();
    for (const s of sockets) {
      const d = s.data as SocketData;
      const expired = (d.tokenExp ?? Infinity) + TOKEN_GRACE_MS < now;
      if (!valid.has(d.auth!.sessionId) || expired) {
        void s.leave(userRoom(d.auth!.userId));
        d.auth = undefined;
        d.authError = expired ? 'TOKEN_EXPIRED' : 'SESSION_REVOKED';
        s.emit('auth:expired', { code: d.authError });
        downgraded++;
      }
    }
    return downgraded;
  }

  /**
   * Authentication runs as connection middleware, so it completes before the
   * connection is accepted and before any event handler can run.
   */
  afterInit(server: Server) {
    // Cross-instance snapshot invalidation (see invalidate()).
    server.on('auction:invalidate', (id: unknown) => {
      if (typeof id === 'string') this.snapshots.delete(id);
    });
    server.use((socket, next) => {
      void this.authenticate(socket).then(
        () => next(),
        () => next(),
      );
    });
    server.on('connection', (socket: Socket) => {
      this.metrics.socketConnections.inc();
      socket.once('disconnect', () => this.metrics.socketConnections.dec());
      const data = socket.data as SocketData;
      if (data.auth) socket.emit('auth:ok', { userId: data.auth.userId });
      else if (data.authError)
        socket.emit('auth:error', { code: data.authError });
    });
  }

  private async authenticate(socket: Socket) {
    const data: SocketData = {
      tokens: BUCKET_CAPACITY,
      refilledAt: Date.now(),
      strikes: 0,
    };
    socket.data = data;
    const token = (
      socket.handshake.auth as Record<string, unknown> | undefined
    )?.['token'];
    if (typeof token !== 'string' || !token) return;
    try {
      data.auth = await this.tokens.authenticate(token);
      data.tokenExp = await this.tokenExpiry(token);
      await socket.join(userRoom(data.auth.userId));
    } catch (err) {
      // Stay connected as an anonymous viewer; the client may refresh and reconnect.
      data.authError = (err as { code?: string }).code ?? 'INVALID_TOKEN';
    }
  }

  private async tokenExpiry(token: string): Promise<number | undefined> {
    const claims = (await this.tokens.verify(token)) as { exp?: number };
    return claims.exp ? claims.exp * 1000 : undefined;
  }

  /**
   * Re-authenticates an open connection with a fresh access token (after the client
   * refreshed it), without reconnecting and without losing room subscriptions.
   */
  @SubscribeMessage('auth:refresh')
  async refreshAuth(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ) {
    const limited = this.limit(socket);
    if (limited) return limited;
    const token =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)['token']
        : undefined;
    if (typeof token !== 'string' || token.length > 4096)
      return fail('INVALID_TOKEN', 'token is required.');
    const d = socket.data as SocketData;
    try {
      const auth = await this.tokens.authenticate(token);
      if (d.auth && d.auth.userId !== auth.userId)
        await socket.leave(userRoom(d.auth.userId));
      d.auth = auth;
      d.authError = undefined;
      d.tokenExp = await this.tokenExpiry(token);
      await socket.join(userRoom(auth.userId));
      return { ok: true, userId: auth.userId };
    } catch (err) {
      return fail(
        (err as { code?: string }).code ?? 'INVALID_TOKEN',
        'Could not authenticate this connection.',
      );
    }
  }

  @SubscribeMessage('auction:join')
  async join(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    const limited = this.limit(socket);
    if (limited) return limited;
    const id = auctionIdOf(body);
    if (!id) return fail('INVALID_AUCTION_ID', 'auctionId must be a UUID.');
    const joined = [...socket.rooms].filter((r) =>
      r.startsWith('auction:'),
    ).length;
    if (!socket.rooms.has(auctionRoom(id)) && joined >= MAX_ROOMS_PER_SOCKET) {
      return fail(
        'TOO_MANY_ROOMS',
        `A connection can follow at most ${MAX_ROOMS_PER_SOCKET} auctions.`,
      );
    }
    // Join FIRST, then read the snapshot: any event committed after the snapshot read
    // is delivered to this socket, and anything before it is in the snapshot. The
    // client ignores events whose version is not newer than the snapshot's.
    const already = socket.rooms.has(auctionRoom(id));
    await socket.join(auctionRoom(id));
    const snapshot = await this.snapshot(socket, id);
    if (!snapshot.ok && !already) await socket.leave(auctionRoom(id));
    return snapshot;
  }

  @SubscribeMessage('auction:sync')
  async sync(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    const limited = this.limit(socket);
    if (limited) return limited;
    const id = auctionIdOf(body);
    if (!id) return fail('INVALID_AUCTION_ID', 'auctionId must be a UUID.');
    return this.snapshot(socket, id);
  }

  @SubscribeMessage('auction:leave')
  async leave(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    const id = auctionIdOf(body);
    if (!id) return fail('INVALID_AUCTION_ID', 'auctionId must be a UUID.');
    await socket.leave(auctionRoom(id));
    return { ok: true };
  }

  /**
   * Clock sync (NTP-style): clients send their local time, we answer with the
   * authoritative time; the client estimates offset = serverTime + rtt/2 - receiveTime.
   */
  @SubscribeMessage('time:sync')
  time(@ConnectedSocket() socket: Socket) {
    const limited = this.limit(socket);
    if (limited) return limited;
    return { ok: true, serverTime: this.dbTime().toISOString() };
  }

  private async snapshot(
    socket: Socket,
    id: string,
  ): Promise<
    Ack<{
      auction: unknown;
      bids: unknown;
      serverTime: string;
      viewers: number;
    }>
  > {
    const auth = (socket.data as SocketData).auth;
    try {
      const { auction, bids } = await this.snapshotFor(id, auth);
      const serverTime = this.dbTime().toISOString();
      return {
        ok: true,
        auction: { ...auction, serverTime },
        bids,
        serverTime,
        // Per-instance count: with several API instances this is a lower bound.
        viewers:
          this.server.of('/').adapter.rooms.get(auctionRoom(id))?.size ?? 0,
      };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'NOT_FOUND')
        return fail('AUCTION_NOT_FOUND', 'Auction not found.');
      this.logger.error(`snapshot ${id} failed: ${(err as Error).message}`);
      return fail('INTERNAL_ERROR', 'Could not load the auction.');
    }
  }

  /**
   * Snapshot for a viewer. Anonymous viewers and ordinary signed-in users share one
   * cached public snapshot per room (refreshed at most once per second, invalidated
   * by every auction event); signed-in users get it personalised in memory plus one
   * small watchlist lookup. Sellers and staff always read fresh, privileged data.
   */
  private async snapshotFor(id: string, auth?: AuthContext): Promise<Snapshot> {
    if (auth) {
      if (auth.permissions.has(Permission.AUCTION_READ_ANY))
        return this.fresh(id, auth);
      const [pubResult, flags] = await Promise.all([
        this.publicSnapshot(id).then(
          (v) => ({ ok: true as const, v }),
          (e: unknown) => ({ ok: false as const, e }),
        ),
        this.auctions.viewerFlags(id, auth.userId),
      ]);
      // Sellers see their own drafts/private fields: always a fresh, privileged read.
      if (flags.isSeller) return this.fresh(id, auth);
      if (!pubResult.ok) throw pubResult.e;
      const pub = pubResult.v;
      const mineAlias = this.bids.aliasFor(id, auth.userId);
      const watching = flags.watching;
      const isHighest = pub.auction.highestBid?.bidderAlias === mineAlias;
      return {
        auction: {
          ...pub.auction,
          highestBid: pub.auction.highestBid
            ? { ...pub.auction.highestBid, mine: isHighest }
            : null,
          result: pub.auction.result
            ? {
                ...pub.auction.result,
                wonByMe: pub.auction.result.winnerAlias === mineAlias,
              }
            : null,
          viewer: { isSeller: false, isHighestBidder: isHighest, watching },
        },
        bids: pub.bids.map((b) => ({
          ...b,
          mine: b.bidderAlias === mineAlias,
        })),
      };
    }
    return this.publicSnapshot(id);
  }

  private publicSnapshot(id: string): Promise<Snapshot> {
    const hit = this.snapshots.get(id);
    if (hit && Date.now() - hit.at < SNAPSHOT_TTL_MS) return hit.promise;
    const promise = this.fresh(id, undefined);
    const entry = { at: Date.now(), promise };
    this.snapshots.set(id, entry);
    promise.catch(() => {
      if (this.snapshots.get(id) === entry) this.snapshots.delete(id);
    });
    if (this.snapshots.size > 5_000) {
      const cutoff = Date.now() - SNAPSHOT_TTL_MS;
      for (const [k, v] of this.snapshots)
        if (v.at < cutoff) this.snapshots.delete(k);
    }
    return promise;
  }

  private async fresh(id: string, auth?: AuthContext): Promise<Snapshot> {
    const [auction, bids] = await Promise.all([
      this.auctions.get(id, auth),
      this.bids.history(id, auth, { limit: 50 }),
    ]);
    return { auction, bids };
  }

  /** Token bucket per connection; persistent abusers are disconnected. */
  private limit(socket: Socket): Ack<object> | null {
    const d = socket.data as SocketData;
    const now = Date.now();
    d.tokens = Math.min(
      BUCKET_CAPACITY,
      d.tokens + ((now - d.refilledAt) / 1000) * BUCKET_REFILL_PER_SEC,
    );
    d.refilledAt = now;
    if (d.tokens >= 1) {
      d.tokens -= 1;
      return null;
    }
    d.strikes += 1;
    if (d.strikes > 50) socket.disconnect(true);
    return fail('RATE_LIMITED', 'Too many requests on this connection.');
  }
}

function auctionIdOf(body: unknown): string | null {
  const id =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)['auctionId']
      : undefined;
  return typeof id === 'string' && UUID.test(id) ? id.toLowerCase() : null;
}

function fail(
  code: string,
  message: string,
): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code, message } };
}
