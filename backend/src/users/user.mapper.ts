import type { Prisma } from '../generated/prisma/client.js';

/** Selection used for the signed-in user's own view. Never includes passwordHash. */
export const meSelect = {
  id: true,
  email: true,
  emailVerifiedAt: true,
  status: true,
  suspendedUntil: true,
  createdAt: true,
  profile: {
    select: {
      displayName: true,
      handle: true,
      avatarUrl: true,
      bio: true,
      phone: true,
      country: true,
    },
  },
  preferences: {
    select: {
      locale: true,
      timezone: true,
      preferredCurrency: true,
      marketingOptIn: true,
    },
  },
  sellerProfile: {
    select: { type: true, businessName: true, verificationStatus: true },
  },
  identityVerification: { select: { status: true } },
  roles: {
    select: {
      role: {
        select: {
          key: true,
          permissions: { select: { permission: { select: { key: true } } } },
        },
      },
    },
  },
} satisfies Prisma.UserSelect;

export type MeRow = Prisma.UserGetPayload<{ select: typeof meSelect }>;

export interface MeDto {
  id: string;
  email: string;
  emailVerified: boolean;
  status: string;
  suspendedUntil: string | null;
  createdAt: string;
  profile: {
    displayName: string;
    handle: string;
    avatarUrl: string | null;
    bio: string | null;
    phone: string | null;
    country: string | null;
  } | null;
  preferences: {
    locale: string;
    timezone: string;
    preferredCurrency: string;
    marketingOptIn: boolean;
  } | null;
  seller: {
    type: string;
    businessName: string | null;
    verificationStatus: string;
  } | null;
  identityVerification: string;
  roles: string[];
  permissions: string[];
}

export function toMeDto(u: MeRow): MeDto {
  const permissions = [
    ...new Set(
      u.roles.flatMap((r) => r.role.permissions.map((p) => p.permission.key)),
    ),
  ].sort();
  return {
    id: u.id,
    email: u.email,
    emailVerified: Boolean(u.emailVerifiedAt),
    status: u.status,
    suspendedUntil: u.suspendedUntil?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
    profile: u.profile,
    preferences: u.preferences,
    seller: u.sellerProfile,
    identityVerification: u.identityVerification?.status ?? 'NOT_STARTED',
    roles: u.roles.map((r) => r.role.key).sort(),
    permissions,
  };
}
