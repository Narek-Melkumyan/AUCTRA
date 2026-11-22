/**
 * Typed, validated application configuration.
 *
 * Every setting is read from environment variables exactly once, at boot. Missing or
 * invalid values fail fast with a message naming the variable — the app never starts
 * with an insecure fallback secret.
 */
export type NodeEnv = 'development' | 'test' | 'production';

export class AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly port: number;
  readonly databaseUrl: string;
  readonly dbPoolMax: number;
  readonly corsOrigins: string[];
  readonly trustProxy: number;

  readonly jwtAccessSecret: string;
  readonly jwtAccessTtlSec: number;
  readonly jwtIssuer = 'auctra';
  readonly jwtAudience = 'auctra-api';
  readonly refreshTokenTtlDays: number;
  readonly refreshTokenIdleDays: number;
  /** Window in which a just-rotated refresh token is answered with 409 instead of being treated as reuse. */
  readonly refreshRaceGraceSec: number;
  readonly csrfSecret: string;
  readonly cookieSecure: boolean;
  readonly cookieDomain: string | undefined;
  readonly ipHashSalt: string;

  readonly argon2MemoryKiB: number;
  readonly argon2TimeCost: number;
  readonly argon2Parallelism: number;
  readonly loginMaxFailures: number;
  readonly loginLockMinutes: number;

  readonly redisUrl: string | undefined;
  readonly appPublicUrl: string;
  readonly emailProvider: 'resend' | 'log' | 'disabled';
  readonly emailFrom: string;
  readonly resendApiKey: string | undefined;

  readonly openaiApiKey: string | undefined;
  readonly openaiModel: string;
  /** Per-user and platform-wide daily token budgets for the AI assistants. */
  readonly aiUserDailyTokens: number;
  readonly aiAdminDailyTokens: number;
  readonly aiGlobalDailyTokens: number;
  readonly aiMaxInputChars: number;

  readonly rateLimitEnabled: boolean;
  readonly lifecycleWorkerEnabled: boolean;
  readonly lifecycleIntervalMs: number;
  readonly outboxRelayEnabled: boolean;
  readonly outboxIntervalMs: number;

  readonly biddingRequireVerifiedEmail: boolean;
  /** Max bid transactions per instance at once (keeps pool headroom for reads). */
  readonly bidMaxConcurrentTx: number;
  /** Max queued bids per auction per instance before answering 503 AUCTION_BUSY. */
  readonly bidQueueMaxPerAuction: number;
  /** Max time a bid waits for the auction row lock before a retryable 503. */
  readonly bidLockTimeoutMs: number;
  /** Bearer token for GET /api/metrics; metrics are disabled when unset. */
  readonly metricsToken: string | undefined;
  readonly auctionRequireReview: boolean;
  readonly endingSoonMinutes: number;

  /** Where uploaded listing images are stored ("disabled" refuses uploads). */
  readonly mediaStorage: 'r2' | 'local' | 'disabled';
  readonly r2:
    | {
        accountId: string;
        accessKeyId: string;
        secretAccessKey: string;
        bucket: string;
        endpoint: string;
        publicBaseUrl: string;
      }
    | undefined;
  /**
   * Optional namespace in front of every object key ("" or e.g. "dev",
   * "integration-tests/<uuid>"), so several environments can share one bucket.
   */
  readonly mediaKeyPrefix: string;
  /** Development disk storage (MEDIA_STORAGE=local); never allowed in production. */
  readonly mediaLocalDir: string;
  readonly mediaLocalPublicUrl: string;
  readonly mediaMaxUploadBytes: number;
  readonly mediaMaxPixels: number;
  readonly mediaMaxImagesPerAuction: number;
  readonly mediaProcessingConcurrency: number;
  readonly mediaProcessingQueueMax: number;

  constructor(env: Record<string, string | undefined>) {
    const errors: string[] = [];
    const str = (
      key: string,
      opts: { required?: boolean; def?: string } = {},
    ) => {
      const v = env[key]?.trim();
      if (v) return v;
      if (opts.def !== undefined) return opts.def;
      if (opts.required) errors.push(`${key} is required`);
      return '';
    };
    const int = (key: string, def: number, min: number, max: number) => {
      const raw = env[key]?.trim();
      if (!raw) return def;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < min || n > max) {
        errors.push(`${key} must be an integer between ${min} and ${max}`);
        return def;
      }
      return n;
    };
    const bool = (key: string, def: boolean) => {
      const raw = env[key]?.trim().toLowerCase();
      if (!raw) return def;
      if (['1', 'true', 'yes'].includes(raw)) return true;
      if (['0', 'false', 'no'].includes(raw)) return false;
      errors.push(`${key} must be true or false`);
      return def;
    };
    const secret = (key: string) => {
      const v = str(key, { required: true });
      if (v && v.length < 32)
        errors.push(`${key} must be at least 32 characters`);
      return v;
    };

    const nodeEnv = str('NODE_ENV', { def: 'development' });
    if (!['development', 'test', 'production'].includes(nodeEnv)) {
      errors.push('NODE_ENV must be development, test or production');
    }
    this.nodeEnv = nodeEnv as NodeEnv;
    const prod = this.nodeEnv === 'production';

    this.port = int('PORT', 4000, 1, 65535);
    this.databaseUrl = str('DATABASE_URL', { required: true });
    this.dbPoolMax = int('DATABASE_POOL_MAX', 10, 1, 200);
    this.corsOrigins = str('FRONTEND_ORIGIN', { def: 'http://localhost:8080' })
      .split(',')
      .map((o) => o.trim().replace(/\/$/, ''))
      .filter(Boolean);
    this.trustProxy = int('TRUST_PROXY_HOPS', 0, 0, 10);

    this.jwtAccessSecret = secret('JWT_ACCESS_SECRET');
    this.jwtAccessTtlSec = parseDuration(
      str('JWT_ACCESS_TTL', { def: '15m' }),
      'JWT_ACCESS_TTL',
      errors,
    );
    if (this.jwtAccessTtlSec > 3600)
      errors.push('JWT_ACCESS_TTL must be at most 1h');
    this.refreshTokenTtlDays = int('REFRESH_TOKEN_TTL_DAYS', 30, 1, 365);
    this.refreshTokenIdleDays = int('REFRESH_TOKEN_IDLE_DAYS', 7, 1, 365);
    this.refreshRaceGraceSec = int('REFRESH_RACE_GRACE_SEC', 10, 0, 60);
    this.csrfSecret = secret('CSRF_SECRET');
    if (this.csrfSecret && this.csrfSecret === this.jwtAccessSecret) {
      errors.push('CSRF_SECRET must differ from JWT_ACCESS_SECRET');
    }
    this.cookieSecure = bool('COOKIE_SECURE', prod);
    if (prod && !this.cookieSecure)
      errors.push('COOKIE_SECURE must be true in production');
    this.cookieDomain = str('COOKIE_DOMAIN') || undefined;
    this.ipHashSalt = str('IP_HASH_SALT', { def: prod ? '' : 'dev-ip-salt' });
    if (prod && !this.ipHashSalt)
      errors.push('IP_HASH_SALT is required in production');

    this.argon2MemoryKiB = int('ARGON2_MEMORY_KIB', 19456, 8192, 1048576);
    this.argon2TimeCost = int('ARGON2_TIME_COST', 2, 1, 10);
    this.argon2Parallelism = int('ARGON2_PARALLELISM', 1, 1, 16);
    this.loginMaxFailures = int('LOGIN_MAX_FAILURES', 5, 1, 100);
    this.loginLockMinutes = int('LOGIN_LOCK_MINUTES', 15, 1, 1440);

    this.redisUrl = str('REDIS_URL') || undefined;
    // FRONTEND_URL is the documented name; APP_PUBLIC_URL is kept for compatibility.
    this.appPublicUrl = (
      str('FRONTEND_URL') ||
      str('APP_PUBLIC_URL', {
        def: this.corsOrigins[0] ?? 'http://localhost:8080',
      })
    ).replace(/\/$/, '');
    if (!/^https?:\/\/[^\s]+$/.test(this.appPublicUrl))
      errors.push('FRONTEND_URL must be an absolute http(s) URL');
    this.resendApiKey = str('RESEND_API_KEY') || undefined;
    // Default: Resend when a key is configured, otherwise the dev log provider.
    const provider = str('EMAIL_PROVIDER', {
      def: this.resendApiKey ? 'resend' : 'log',
    });
    if (!['resend', 'log', 'disabled'].includes(provider))
      errors.push('EMAIL_PROVIDER must be "resend", "log" or "disabled"');
    this.emailProvider = provider as 'resend' | 'log' | 'disabled';
    this.emailFrom =
      str('RESEND_FROM_EMAIL') ||
      str('EMAIL_FROM', { def: 'AUCTRA <no-reply@auctra.local>' });
    if (this.emailProvider === 'resend') {
      if (!this.resendApiKey)
        errors.push('RESEND_API_KEY is required when EMAIL_PROVIDER=resend');
      if (!str('RESEND_FROM_EMAIL') && !str('EMAIL_FROM'))
        errors.push(
          'RESEND_FROM_EMAIL is required when EMAIL_PROVIDER=resend (an address on a domain verified in Resend, or onboarding@resend.dev for testing)',
        );
    }
    if (prod && this.emailProvider === 'log')
      errors.push('EMAIL_PROVIDER=log is not allowed in production');

    this.openaiApiKey = str('OPENAI_API_KEY') || undefined;
    this.openaiModel = str('OPENAI_MODEL', { def: 'gpt-5-mini' });
    this.aiUserDailyTokens = int('AI_USER_DAILY_TOKENS', 60_000, 0, 10_000_000);
    this.aiAdminDailyTokens = int(
      'AI_ADMIN_DAILY_TOKENS',
      250_000,
      0,
      50_000_000,
    );
    this.aiGlobalDailyTokens = int(
      'AI_GLOBAL_DAILY_TOKENS',
      2_000_000,
      0,
      500_000_000,
    );
    this.aiMaxInputChars = int('AI_MAX_INPUT_CHARS', 2000, 100, 20_000);

    this.rateLimitEnabled = bool('RATE_LIMIT_ENABLED', true);
    this.lifecycleWorkerEnabled = bool('LIFECYCLE_WORKER_ENABLED', true);
    this.lifecycleIntervalMs = int('LIFECYCLE_INTERVAL_MS', 1000, 100, 60000);
    this.outboxRelayEnabled = bool('OUTBOX_RELAY_ENABLED', true);
    this.outboxIntervalMs = int('OUTBOX_INTERVAL_MS', 250, 20, 60000);

    this.biddingRequireVerifiedEmail = bool(
      'BIDDING_REQUIRE_VERIFIED_EMAIL',
      true,
    );
    this.auctionRequireReview = bool('AUCTION_REQUIRE_REVIEW', true);
    this.bidMaxConcurrentTx = int(
      'BID_MAX_CONCURRENT_TX',
      Math.max(1, this.dbPoolMax - 3),
      1,
      Math.max(1, this.dbPoolMax),
    );
    this.bidQueueMaxPerAuction = int(
      'BID_QUEUE_MAX_PER_AUCTION',
      500,
      1,
      100_000,
    );
    this.bidLockTimeoutMs = int('BID_LOCK_TIMEOUT_MS', 3_000, 100, 30_000);
    this.metricsToken = str('METRICS_TOKEN') || undefined;
    if (this.metricsToken && this.metricsToken.length < 24)
      errors.push('METRICS_TOKEN must be at least 24 characters');
    this.endingSoonMinutes = int('ENDING_SOON_MINUTES', 15, 1, 1440);

    // ── Media storage ──
    const r2Keys = [
      'R2_ACCOUNT_ID',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'R2_PUBLIC_BASE_URL',
    ];
    const anyR2 = r2Keys.some((k) => str(k));
    const storage = str('MEDIA_STORAGE', {
      def: anyR2 ? 'r2' : this.nodeEnv === 'development' ? 'local' : 'disabled',
    });
    if (!['r2', 'local', 'disabled'].includes(storage))
      errors.push('MEDIA_STORAGE must be "r2", "local" or "disabled"');
    this.mediaStorage = storage as AppConfig['mediaStorage'];
    if (this.mediaStorage === 'r2') {
      for (const k of r2Keys)
        if (!str(k)) errors.push(`${k} is required for Cloudflare R2 storage`);
      const accountId = str('R2_ACCOUNT_ID');
      if (accountId && !/^[a-f0-9]{32}$/.test(accountId))
        errors.push(
          'R2_ACCOUNT_ID must be the 32-character Cloudflare account ID',
        );
      const bucket = str('R2_BUCKET_NAME', { def: 'auctra' });
      if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket))
        errors.push('R2_BUCKET_NAME must be a valid R2 bucket name');
      const publicBaseUrl = str('R2_PUBLIC_BASE_URL').replace(/\/+$/, '');
      if (
        publicBaseUrl &&
        !/^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(publicBaseUrl)
      )
        errors.push(
          'R2_PUBLIC_BASE_URL must be an https:// URL (an r2.dev URL or a custom domain connected to the bucket)',
        );
      const endpoint = str('R2_ENDPOINT', {
        def: accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '',
      }).replace(/\/+$/, '');
      this.r2 = {
        accountId,
        accessKeyId: str('R2_ACCESS_KEY_ID'),
        secretAccessKey: str('R2_SECRET_ACCESS_KEY'),
        bucket,
        endpoint,
        publicBaseUrl,
      };
    } else {
      this.r2 = undefined;
    }
    if (prod && this.mediaStorage === 'local')
      errors.push('MEDIA_STORAGE=local is not allowed in production; use r2');
    this.mediaKeyPrefix = str('MEDIA_KEY_PREFIX').replace(/^\/+|\/+$/g, '');
    if (
      this.mediaKeyPrefix &&
      !/^[a-z0-9][a-z0-9-]{0,62}(?:\/[a-z0-9][a-z0-9-]{0,62}){0,3}$/.test(
        this.mediaKeyPrefix,
      )
    )
      errors.push(
        'MEDIA_KEY_PREFIX must be up to 4 lowercase path segments (a-z, 0-9, "-"), e.g. "dev"',
      );
    this.mediaLocalDir = str('MEDIA_LOCAL_DIR', { def: 'storage/media' });
    this.mediaLocalPublicUrl = str('MEDIA_LOCAL_PUBLIC_URL', {
      def: `http://localhost:${this.port}/media`,
    }).replace(/\/+$/, '');
    this.mediaMaxUploadBytes =
      int('MEDIA_MAX_UPLOAD_MB', 10, 1, 50) * 1024 * 1024;
    this.mediaMaxPixels = int(
      'MEDIA_MAX_PIXELS',
      40_000_000,
      1_000_000,
      268_402_689,
    );
    this.mediaMaxImagesPerAuction = int(
      'MEDIA_MAX_IMAGES_PER_AUCTION',
      12,
      1,
      30,
    );
    this.mediaProcessingConcurrency = int(
      'MEDIA_PROCESSING_CONCURRENCY',
      2,
      1,
      16,
    );
    this.mediaProcessingQueueMax = int(
      'MEDIA_PROCESSING_QUEUE_MAX',
      16,
      0,
      1000,
    );

    if (errors.length) {
      throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
    }
  }

  get isProduction() {
    return this.nodeEnv === 'production';
  }
}

function parseDuration(raw: string, key: string, errors: string[]): number {
  const m = /^(\d+)\s*(s|m|h)?$/.exec(raw);
  if (!m) {
    errors.push(`${key} must look like 900, 900s, 15m or 1h`);
    return 900;
  }
  const n = Number(m[1]);
  const unit = m[2] ?? 's';
  return unit === 'h' ? n * 3600 : unit === 'm' ? n * 60 : n;
}
