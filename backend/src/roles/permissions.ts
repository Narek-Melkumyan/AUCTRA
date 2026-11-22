/**
 * Permission catalogue and the default role → permission matrix.
 *
 * Controllers declare the permission they need (`@RequirePermissions`); they never
 * check role names. Roles and assignments live in the database, so new roles can be
 * introduced without code changes. This file is the source the seed script syncs from.
 */
export const Permission = {
  BID_PLACE: 'bid:place',
  WATCHLIST_MANAGE: 'watchlist:manage',
  MESSAGE_SEND: 'message:send',
  REPORT_CREATE: 'report:create',
  SELLER_APPLY: 'seller:apply',
  ORDER_READ_OWN: 'order:read:own',
  DISPUTE_OPEN: 'dispute:open',
  CHAT_SEND: 'chat:send',
  AI_ASSISTANT: 'ai:assistant',

  AUCTION_CREATE: 'auction:create',
  AUCTION_MANAGE_OWN: 'auction:manage:own',

  AUCTION_READ_ANY: 'auction:read:any',
  AUCTION_MODERATE: 'auction:moderate',
  USER_READ_ANY: 'user:read:any',
  USER_SUSPEND: 'user:suspend',
  SELLER_VERIFY: 'seller:verify',
  REPORT_HANDLE: 'report:handle',
  DISPUTE_HANDLE: 'dispute:handle',
  ORDER_READ_ANY: 'order:read:any',
  AUDIT_READ: 'audit:read',
  CATEGORY_MANAGE: 'category:manage',
  CHAT_MODERATE: 'chat:moderate',
  NOTIFICATION_BROADCAST: 'notification:broadcast',
  ANALYTICS_READ: 'analytics:read',
  AI_ADMIN: 'ai:admin',

  ROLE_ASSIGN: 'role:assign',
  CONFIG_MANAGE: 'config:manage',
} as const;

export type PermissionKey = (typeof Permission)[keyof typeof Permission];

export const RoleKey = {
  USER: 'USER',
  SELLER: 'SELLER',
  MODERATOR: 'MODERATOR',
  ADMIN: 'ADMIN',
  SUPER_ADMIN: 'SUPER_ADMIN',
} as const;
export type RoleKey = (typeof RoleKey)[keyof typeof RoleKey];

const USER_PERMS: PermissionKey[] = [
  Permission.BID_PLACE,
  Permission.WATCHLIST_MANAGE,
  Permission.MESSAGE_SEND,
  Permission.REPORT_CREATE,
  Permission.SELLER_APPLY,
  Permission.ORDER_READ_OWN,
  Permission.DISPUTE_OPEN,
  Permission.CHAT_SEND,
  Permission.AI_ASSISTANT,
];
const SELLER_PERMS: PermissionKey[] = [
  Permission.AUCTION_CREATE,
  Permission.AUCTION_MANAGE_OWN,
];
const ADMIN_PERMS: PermissionKey[] = [
  Permission.AUCTION_READ_ANY,
  Permission.AUCTION_MODERATE,
  Permission.USER_READ_ANY,
  Permission.USER_SUSPEND,
  Permission.SELLER_VERIFY,
  Permission.REPORT_HANDLE,
  Permission.DISPUTE_HANDLE,
  Permission.ORDER_READ_ANY,
  Permission.AUDIT_READ,
  Permission.CATEGORY_MANAGE,
  Permission.CHAT_MODERATE,
  Permission.NOTIFICATION_BROADCAST,
  Permission.ANALYTICS_READ,
  Permission.AI_ADMIN,
];
/** Content moderation only: chat, reports, read access needed to judge them. */
const MODERATOR_PERMS: PermissionKey[] = [
  Permission.CHAT_MODERATE,
  Permission.REPORT_HANDLE,
  Permission.USER_READ_ANY,
  Permission.AUCTION_READ_ANY,
];
const SUPER_ADMIN_PERMS: PermissionKey[] = [
  Permission.ROLE_ASSIGN,
  Permission.CONFIG_MANAGE,
];

/** Roles are additive: a SELLER also holds USER, an ADMIN holds USER (not SELLER). */
export const DEFAULT_ROLES: Record<
  RoleKey,
  { name: string; description: string; permissions: PermissionKey[] }
> = {
  USER: {
    name: 'User',
    description: 'Registered buyer',
    permissions: USER_PERMS,
  },
  SELLER: {
    name: 'Seller',
    description: 'Verified seller who can list auctions',
    permissions: SELLER_PERMS,
  },
  MODERATOR: {
    name: 'Moderator',
    description: 'Moderates auction chat and handles user reports',
    permissions: MODERATOR_PERMS,
  },
  ADMIN: {
    name: 'Administrator',
    description: 'Moderation and operations',
    permissions: ADMIN_PERMS,
  },
  SUPER_ADMIN: {
    name: 'Super administrator',
    description: 'Full access including role assignment and configuration',
    permissions: [...ADMIN_PERMS, ...SUPER_ADMIN_PERMS],
  },
};
