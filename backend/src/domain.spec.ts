import { applyBps, money, parseMinor } from './common/money.js';
import {
  canTransition,
  phaseOf,
  TRANSITIONS,
} from './auctions/auction-state.js';
import {
  BidderAliases,
  minimumNextBid,
  reserveState,
} from './auctions/auction.mapper.js';
import { parseRefreshToken } from './auth/session.service.js';
import { AppConfig } from './config/app-config.js';
import { formatMinor } from './bids/bids.service.js';

describe('money', () => {
  it('parses only non-negative integer minor-unit strings', () => {
    expect(parseMinor('0')).toBe(0n);
    expect(parseMinor('900000000000000001')).toBe(900000000000000001n);
    for (const bad of [
      '',
      '01',
      '1.5',
      '-1',
      '1e3',
      ' 1',
      '1000000000000000000',
    ]) {
      expect(() => parseMinor(bad)).toThrow(RangeError);
    }
  });

  it('applies basis points exactly with half-up rounding', () => {
    expect(applyBps(10_000n, 250)).toBe(250n);
    expect(applyBps(199n, 50)).toBe(1n); // 0.995 → 1
    expect(applyBps(100n, 0)).toBe(0n);
    expect(applyBps(123_456_789_012_345_678n, 1000)).toBe(
      12_345_678_901_234_568n,
    );
    expect(() => applyBps(1n, 10_001)).toThrow();
  });

  it('serialises as strings', () => {
    expect(JSON.parse(JSON.stringify(money(2n ** 62n, 'USD')))).toEqual({
      minor: '4611686018427387904',
      currency: 'USD',
    });
    expect(formatMinor(1_234_567n, 'USD')).toBe('USD 12,345.67');
    expect(formatMinor(1_200_000n, 'USD')).toBe('USD 12,000');
    expect(formatMinor(5000n, 'JPY')).toBe('JPY 5,000');
  });
});

describe('auction state machine', () => {
  it('allows only the documented transitions', () => {
    expect(canTransition('DRAFT', 'PENDING_REVIEW')).toBe(true);
    expect(canTransition('LIVE', 'ENDED')).toBe(true);
    expect(canTransition('ENDED', 'SOLD')).toBe(true);
    expect(canTransition('LIVE', 'SOLD')).toBe(false);
    expect(canTransition('ENDED', 'LIVE')).toBe(false);
    expect(canTransition('SCHEDULED', 'DRAFT')).toBe(false);
    for (const terminal of ['SOLD', 'UNSOLD', 'CANCELLED'] as const)
      expect(TRANSITIONS[terminal]).toEqual([]);
  });

  it('derives the phase from authoritative time, not only stored status', () => {
    const now = new Date('2026-01-01T12:00:00Z');
    const a = (
      status: Parameters<typeof phaseOf>[0]['status'],
      startH: number,
      endH: number,
    ) => ({
      status,
      startsAt: new Date(now.getTime() + startH * 3600_000),
      endsAt: new Date(now.getTime() + endH * 3600_000),
    });
    expect(phaseOf(a('LIVE', -1, 1), now)).toBe('live');
    expect(phaseOf(a('LIVE', -2, -1), now)).toBe('ended'); // closing job not run yet
    expect(phaseOf(a('SCHEDULED', 1, 2), now)).toBe('upcoming');
    expect(phaseOf(a('SCHEDULED', -1, 1), now)).toBe('live');
    expect(phaseOf(a('SOLD', -2, -1), now)).toBe('ended');
  });

  it('computes minimum next bid and reserve status', () => {
    expect(
      minimumNextBid({
        currentPriceCents: null,
        startingPriceCents: 1000n,
        minIncrementCents: 50n,
      }),
    ).toBe(1000n);
    expect(
      minimumNextBid({
        currentPriceCents: 1000n,
        startingPriceCents: 1000n,
        minIncrementCents: 50n,
      }),
    ).toBe(1050n);
    expect(
      reserveState({ reservePriceCents: null, currentPriceCents: null }),
    ).toBe('none');
    expect(
      reserveState({ reservePriceCents: 500n, currentPriceCents: 499n }),
    ).toBe('not_met');
    expect(
      reserveState({ reservePriceCents: 500n, currentPriceCents: 500n }),
    ).toBe('met');
  });

  it('gives bidders stable per-auction aliases that do not link across auctions', () => {
    const aliases = new BidderAliases('s'.repeat(40));
    const a1 = aliases.alias('auction-1', 'user-1');
    expect(a1).toBe(aliases.alias('auction-1', 'user-1'));
    expect(a1).not.toBe(aliases.alias('auction-2', 'user-1'));
    expect(a1).toMatch(/^bidder_[0-9a-f]{6}$/);
  });
});

describe('refresh token format', () => {
  it('accepts "<uuid>.<secret>" only', () => {
    expect(
      parseRefreshToken(
        '3f1c1b7e-8b1e-4a43-9d6e-1f2a3b4c5d6e.abcdefghijklmnopqrstuvwxyz012345',
      ),
    ).toEqual({
      id: '3f1c1b7e-8b1e-4a43-9d6e-1f2a3b4c5d6e',
      secret: 'abcdefghijklmnopqrstuvwxyz012345',
    });
    for (const bad of [
      undefined,
      '',
      'nodot',
      '.secret',
      'not-a-uuid.abcdefghijklmnopqrstuvwxyz',
      `${'a'.repeat(36)}.short`,
    ]) {
      expect(parseRefreshToken(bad)).toBeNull();
    }
  });
});

describe('configuration', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    CSRF_SECRET: 'b'.repeat(48),
  };

  it('fails fast on missing or weak secrets', () => {
    expect(() => new AppConfig({})).toThrow(/DATABASE_URL is required/);
    expect(
      () => new AppConfig({ ...base, JWT_ACCESS_SECRET: 'short' }),
    ).toThrow(/at least 32/);
    expect(
      () => new AppConfig({ ...base, CSRF_SECRET: base.JWT_ACCESS_SECRET }),
    ).toThrow(/must differ/);
    expect(() => new AppConfig({ ...base, JWT_ACCESS_TTL: '2h' })).toThrow(
      /at most 1h/,
    );
  });

  it('enforces production hardening', () => {
    expect(
      () =>
        new AppConfig({
          ...base,
          NODE_ENV: 'production',
          COOKIE_SECURE: 'false',
          IP_HASH_SALT: 'x',
        }),
    ).toThrow(/COOKIE_SECURE/);
    expect(() => new AppConfig({ ...base, NODE_ENV: 'production' })).toThrow(
      /IP_HASH_SALT/,
    );
    expect(
      () =>
        new AppConfig({ ...base, NODE_ENV: 'production', IP_HASH_SALT: 's' }),
    ).toThrow(/EMAIL_PROVIDER=log/);
    const prod = new AppConfig({
      ...base,
      NODE_ENV: 'production',
      IP_HASH_SALT: 'salt',
      EMAIL_PROVIDER: 'disabled',
    });
    expect(prod.cookieSecure).toBe(true);
  });

  it('parses durations and origin lists', () => {
    const c = new AppConfig({
      ...base,
      JWT_ACCESS_TTL: '10m',
      FRONTEND_ORIGIN: 'http://a.test/, http://b.test',
    });
    expect(c.jwtAccessTtlSec).toBe(600);
    expect(c.corsOrigins).toEqual(['http://a.test', 'http://b.test']);
  });
});
