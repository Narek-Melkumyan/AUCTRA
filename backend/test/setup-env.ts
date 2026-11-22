/**
 * Test environment: always the dedicated *_test database, background workers off
 * (tests drive them explicitly), rate limiting off except where a test enables it,
 * cheap Argon2 parameters for speed.
 */
import { config as loadDotenv } from 'dotenv';

loadDotenv({ quiet: true });

const testUrl = process.env['DATABASE_URL_TEST'];
if (!testUrl)
  throw new Error('DATABASE_URL_TEST must be set (see .env.example)');
const dbName = new URL(testUrl).pathname.replace(/^\//, '');
if (!dbName.endsWith('_test'))
  throw new Error(
    `Refusing to run tests against "${dbName}": name must end in _test`,
  );

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: testUrl,
  FRONTEND_ORIGIN: 'http://localhost:5173',
  LIFECYCLE_WORKER_ENABLED: 'false',
  OUTBOX_RELAY_ENABLED: 'true',
  OUTBOX_INTERVAL_MS: '50',
  RATE_LIMIT_ENABLED: 'false',
  BIDDING_REQUIRE_VERIFIED_EMAIL: 'true',
  AUCTION_REQUIRE_REVIEW: 'true',
  ARGON2_MEMORY_KIB: '8192',
  ARGON2_TIME_COST: '1',
  REFRESH_RACE_GRACE_SEC: '10',
  REDIS_URL: process.env['TEST_REDIS_URL'] ?? '',
  EMAIL_PROVIDER: 'log',
  // Never reach a real bucket from automated tests, even if .env holds R2 credentials:
  // suites that need storage inject an in-memory driver (test/fake-storage.ts).
  MEDIA_STORAGE: 'disabled',
  R2_ACCOUNT_ID: '',
  R2_ACCESS_KEY_ID: '',
  R2_SECRET_ACCESS_KEY: '',
  R2_PUBLIC_BASE_URL: '',
  // Tests assert the canonical key layout; a developer's namespace (e.g. "dev") must not leak in.
  MEDIA_KEY_PREFIX: '',
});
