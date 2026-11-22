import { INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Server, ServerOptions } from 'socket.io';
import { AppConfig } from '../config/app-config.js';
import { RedisService } from '../redis/redis.service.js';

/**
 * Socket.IO server factory.
 *
 * With REDIS_URL set, every instance attaches the Redis pub/sub adapter so that an
 * emit to a room on one instance reaches sockets connected to any other instance.
 * Without Redis, broadcasts only reach sockets on the same process — fine for a single
 * instance, NOT sufficient behind a multi-instance load balancer.
 */
export class AuctraIoAdapter extends IoAdapter {
  private readonly log = new Logger(AuctraIoAdapter.name);
  private redisAdapter?: ReturnType<typeof createAdapter>;

  constructor(private readonly appCtx: INestApplicationContext) {
    super(appCtx);
  }

  async connectRedis(): Promise<void> {
    const redis = this.appCtx.get(RedisService);
    if (!redis.enabled) {
      this.log.warn(
        'REDIS_URL not set: Socket.IO runs in single-instance mode',
      );
      return;
    }
    const pub = await redis.connectNew('socket.io-pub');
    const sub = await redis.connectNew('socket.io-sub', 3_000, {
      queueWhileDisconnected: true,
    });
    // The adapter calls publish() without handling rejection. While Redis is down that
    // would surface as unhandled rejections (and crash Node), so wrap it: a failed
    // cross-instance publish is logged and counted; clients on other instances recover
    // through the periodic room heartbeat + version-gap resync.
    let failures = 0;
    let lastLog = 0;
    const safePub = new Proxy(pub, {
      get: (target, prop, receiver) => {
        if (prop === 'publish')
          return (...args: Parameters<typeof target.publish>) =>
            target.publish(...args).catch((err: Error) => {
              failures++;
              if (Date.now() - lastLog > 10_000) {
                lastLog = Date.now();
                this.log.warn(
                  `Cross-instance publish failed (${failures} so far): ${err.message}`,
                );
              }
              return 0;
            });
        const v: unknown = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? (v as () => unknown).bind(target) : v;
      },
    });
    // Subscribe commands queued while Redis is down are rejected if the client is
    // destroyed (shutdown); the adapter does not handle that, so guard them too.
    const guarded = new Set([
      'subscribe',
      'pSubscribe',
      'sSubscribe',
      'unsubscribe',
      'pUnsubscribe',
      'sUnsubscribe',
    ]);
    const safeSub = new Proxy(sub, {
      get: (target, prop, receiver) => {
        const v: unknown = Reflect.get(target, prop, receiver);
        if (typeof v !== 'function') return v;
        const fn = (v as (...a: unknown[]) => unknown).bind(target);
        if (!guarded.has(String(prop))) return fn;
        return (...args: unknown[]) => {
          const r = fn(...args);
          return r instanceof Promise
            ? r.catch((err: Error) => {
                this.log.warn(`Redis ${String(prop)} failed: ${err.message}`);
              })
            : r;
        };
      },
    });
    this.redisAdapter = createAdapter(safePub, safeSub, { key: 'auctra.io' });
    this.log.log('Socket.IO Redis adapter enabled');
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const config = this.appCtx.get(AppConfig);
    const server = super.createIOServer(port, {
      ...options,
      path: '/socket.io',
      cors: { origin: config.corsOrigins, credentials: true },
      // Bound the cost of a single client.
      maxHttpBufferSize: 16 * 1024,
      pingInterval: 25_000,
      pingTimeout: 20_000,
    } as ServerOptions) as Server;
    if (this.redisAdapter) server.adapter(this.redisAdapter);
    return server;
  }
}
