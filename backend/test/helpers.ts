import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import * as argon2 from 'argon2';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  EMAIL_PROVIDER,
  LogEmailProvider,
} from '../src/email/email.service.js';
import { seedReferenceData } from '../src/database/reference-data.js';
import { RoleKey } from '../src/roles/permissions.js';
import type { Prisma } from '../src/generated/prisma/client.js';

export const ORIGIN = 'http://localhost:5173';
export const PASSWORD = 'correct horse battery staple';

export interface TestApp {
  app: INestApplication;
  prisma: PrismaService;
  url: string;
  http: ReturnType<INestApplication['getHttpServer']>;
  emails: LogEmailProvider['outbox'];
  close: () => Promise<void>;
}

export async function createTestApp(
  overrides?: (b: ReturnType<typeof Test.createTestingModule>) => void,
): Promise<TestApp> {
  const builder = Test.createTestingModule({ imports: [AppModule] });
  overrides?.(builder);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    logger: false,
  });
  Logger.overrideLogger(false);
  await configureApp(app);
  await app.listen(0, '127.0.0.1');
  const port = (app.getHttpServer().address() as AddressInfo).port;
  const prisma = app.get(PrismaService);
  const provider = app.get<LogEmailProvider>(EMAIL_PROVIDER);
  return {
    app,
    prisma,
    url: `http://127.0.0.1:${port}`,
    http: app.getHttpServer(),
    emails: provider.outbox,
    close: () => app.close(),
  };
}

/** Empties every table (test DB only — guarded in setup-env) and re-syncs reference data. */
export async function resetDb(prisma: PrismaService) {
  const db = (
    await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`
  )[0]!.db;
  if (!db.endsWith('_test')) throw new Error(`resetDb refused on ${db}`);
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const sql = `TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`;
  // TRUNCATE can deadlock with background work still finishing from the previous test
  // (outbox relay, fire-and-forget password reset); retry briefly.
  for (let attempt = 0; ; attempt++) {
    try {
      await prisma.$executeRawUnsafe(sql);
      break;
    } catch (err) {
      if (attempt >= 5 || !String((err as Error).message).includes('deadlock'))
        throw err;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
  await seedReferenceData(prisma);
}

let hashCache: string | undefined;
async function passwordHash() {
  hashCache ??= await argon2.hash(PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 8192,
    timeCost: 1,
    parallelism: 1,
  });
  return hashCache;
}

export async function createUser(
  prisma: PrismaService,
  opts: {
    roles?: string[];
    verified?: boolean;
    email?: string;
    status?: 'ACTIVE' | 'SUSPENDED' | 'BANNED';
  } = {},
) {
  const email = opts.email ?? `user-${randomUUID().slice(0, 8)}@test.auctra`;
  const roles = opts.roles ?? [RoleKey.USER];
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await passwordHash(),
      emailVerifiedAt: opts.verified === false ? null : new Date(),
      status: opts.status ?? 'ACTIVE',
      profile: {
        create: {
          displayName: email.split('@')[0]!,
          handle: `h_${randomUUID().slice(0, 8)}`,
        },
      },
      preferences: { create: {} },
    },
  });
  for (const key of roles) {
    const role = await prisma.role.findUniqueOrThrow({ where: { key } });
    await prisma.userRole.create({
      data: { userId: user.id, roleId: role.id },
    });
  }
  if (roles.includes(RoleKey.SELLER)) {
    await prisma.sellerProfile.create({
      data: {
        userId: user.id,
        type: 'DEALER',
        businessName: 'Test Dealer',
        verificationStatus: 'VERIFIED',
      },
    });
  }
  return user;
}

export interface Session {
  agent: ReturnType<typeof request.agent>;
  token: string;
  csrf: string;
  userId: string;
}

/** Signs in through the real HTTP flow (CSRF → login) and keeps cookies in a supertest agent. */
export async function login(
  t: TestApp,
  email: string,
  password = PASSWORD,
): Promise<Session> {
  const agent = request.agent(t.http);
  const csrf = (await agent.get('/api/auth/csrf').expect(200)).body
    .csrfToken as string;
  const res = await agent
    .post('/api/auth/login')
    .set('Origin', ORIGIN)
    .set('X-CSRF-Token', csrf)
    .send({ email, password })
    .expect(200);
  return { agent, token: res.body.accessToken, csrf, userId: res.body.user.id };
}

export async function signedIn(
  t: TestApp,
  opts: Parameters<typeof createUser>[1] = {},
) {
  const user = await createUser(t.prisma, opts);
  return { user, session: await login(t, user.email) };
}

export function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

/** Inserts an approved auction directly (bypassing the listing flow) for bidding tests. */
export async function createLiveAuction(
  prisma: PrismaService,
  sellerId: string,
  overrides: Partial<Prisma.AuctionUncheckedCreateInput> = {},
) {
  const category = await prisma.category.findUniqueOrThrow({
    where: { slug: 'watches' },
  });
  const now = Date.now();
  const endsAt =
    (overrides.endsAt as Date | undefined) ?? new Date(now + 10 * 60_000);
  return prisma.auction.create({
    data: {
      sellerId,
      categoryId: category.id,
      title: 'Test chronograph',
      description: 'A test auction used by the integration suite.',
      condition: 'EXCELLENT',
      currency: 'USD',
      startingPriceCents: 100_000n,
      minIncrementCents: 5_000n,
      startsAt: new Date(now - 60_000),
      endsAt,
      originalEndsAt: endsAt,
      status: 'LIVE',
      ...overrides,
    },
  });
}

export function bid(
  t: TestApp,
  s: Session,
  auctionId: string,
  amountMinor: string,
  key: string = randomUUID(),
) {
  return request(t.http)
    .post(`/api/auctions/${auctionId}/bids`)
    .set(auth(s.token))
    .set('Idempotency-Key', key)
    .send({ amountMinor });
}

export function refreshCookie(res: request.Response): string | undefined {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  return raw
    ?.find((c) => c.startsWith('auctra_rt='))
    ?.split(';')[0]
    ?.slice('auctra_rt='.length);
}
