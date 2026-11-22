/** Typed client for the staff-only /api/admin endpoints. Every call is authorised server-side. */
import { api } from "./client";

export type Money = { minor: string; currency: string };
export type Page<T> = { total: number; page: number; limit: number; items: T[] };

export type Analytics = {
  periodDays: number;
  generatedAt: string;
  totals: {
    users: number;
    verifiedUsers: number;
    newUsers: number;
    activeUsers7d: number;
    activeUsers24h: number;
    liveAuctions: number;
    scheduledAuctions: number;
    pendingReview: number;
    completedAuctions: number;
    soldAuctions: number;
    unsoldAuctions: number;
    bids: number;
    bidsInPeriod: number;
    activeBidders: number;
    chatMessages: number;
    openReports: number;
    pendingSellers: number;
  };
  auctionStatus: Record<string, number>;
  bidsOverTime: { day: string; bids: number; bidders: number }[];
  registrationsOverTime: { day: string; users: number }[];
  categories: { slug: string; name: string; auctions: number; live: number; bids: number }[];
  mostActiveAuctions: {
    id: string;
    title: string;
    status: string;
    bidCount: number;
    bidders: number;
    chatMessages: number;
    endsAt: string;
    price: Money;
  }[];
  checkout: {
    ordersTotal: number;
    byStatus: Record<string, number>;
    demoCompleted: number;
    completionRate: number;
  };
  salesVolume: { orders: number; hammer: Money }[];
};

export type AdminUser = {
  id: string;
  email: string;
  status: string;
  suspendedUntil: string | null;
  emailVerified: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  handle: string | null;
  displayName: string | null;
  roles: string[];
  sellerStatus: string | null;
  bids: number;
  auctions: number;
};

export type AdminUserDetail = {
  id: string;
  email: string;
  status: string;
  suspendedUntil: string | null;
  suspensionReason: string | null;
  emailVerified: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  failedLoginCount: number;
  lockedUntil: string | null;
  profile: {
    handle: string;
    displayName: string;
    country: string | null;
    bio: string | null;
  } | null;
  roles: string[];
  sellerProfile: {
    verificationStatus: string;
    type: string;
    businessName: string | null;
    rejectionReason: string | null;
    createdAt: string;
  } | null;
  counts: {
    bids: number;
    auctionsSelling: number;
    auctionsWon: number;
    chatMessages: number;
    ordersAsBuyer: number;
    reportsFiled: number;
  };
  reportsAgainst: number;
  chatRestriction: {
    id: string;
    type: string;
    expiresAt: string | null;
    reason: string | null;
  } | null;
  recentBids: {
    id: string;
    auctionId: string;
    auctionTitle: string;
    auctionStatus: string;
    amount: Money;
    createdAt: string;
  }[];
  activity: { id: string; action: string; actorId: string | null; createdAt: string }[];
  moderation: { action: string; reason: string | null; createdAt: string }[];
  sessions?: {
    id: string;
    userAgent: string | null;
    network: string | null;
    createdAt: string;
    lastActiveAt: string;
  }[];
};

export type AdminAuction = {
  id: string;
  lotNumber: number;
  title: string;
  status: string;
  category: string;
  seller: { id: string; handle: string | null; email: string };
  startsAt: string;
  endsAt: string;
  bidCount: number;
  price: Money;
  reserve: Money | null;
  winner: { id: string; handle: string | null; email: string } | null;
  order: { id: string; orderNumber: string; status: string } | null;
  cancelReason: string | null;
};

export type AdminAuctionDetail = Omit<AdminAuction, "order"> & {
  startPrice: Money;
  order: {
    id: string;
    orderNumber: string;
    status: string;
    total: Money;
    demoCompletedAt: string | null;
  } | null;
  bids: {
    id: string;
    sequence: number;
    amount: Money;
    status: string;
    createdAt: string;
    bidder: { id: string; handle: string | null; email: string };
    network: string | null;
  }[];
  events: {
    id: string;
    type: string;
    fromStatus: string | null;
    toStatus: string | null;
    createdAt: string;
  }[];
};

export type SellerApplication = {
  userId: string;
  type: string;
  businessName: string | null;
  createdAt: string;
  user: { email: string; profile: { handle: string; displayName: string } | null };
};

export type ReportItem = {
  id: string;
  targetType: string;
  targetId: string;
  reason: string;
  details: string | null;
  status: string;
  resolution: string | null;
  createdAt: string;
  reporter: string | null;
  handledBy: string | null;
  target: Record<string, unknown> | null;
};

export type AdminChatMessage = {
  id: string;
  seq: string;
  auctionId: string;
  auctionTitle: string;
  authorId: string;
  author: { handle: string; displayName: string; isSeller: boolean; isStaff: boolean };
  body: string | null;
  status: "VISIBLE" | "HIDDEN" | "DELETED";
  createdAt: string;
  openReports: number;
  moderation?: { reason: string | null; at: string | null };
};

export type ChatRestriction = {
  id: string;
  userId: string;
  handle: string | null;
  email: string;
  type: "MUTE" | "BAN";
  reason: string | null;
  expiresAt: string | null;
  createdAt: string;
  createdBy: string | null;
  revokedAt: string | null;
  active: boolean;
};

export type ModerationLogEntry = {
  id: string;
  action: string;
  targetType: string;
  targetId: string;
  moderator: string | null;
  subject: string | null;
  reason: string | null;
  createdAt: string;
};

export type Announcement = {
  id: string;
  title: string;
  body: string;
  audience: string;
  sendEmail: boolean;
  link: string | null;
  recipientCount: number;
  createdAt: string;
  read: number;
  deliveries: { channel: string; status: string; count: number }[];
};

export type Delivery = {
  id: string;
  channel: string;
  status: string;
  attempts: number;
  lastError: string | null;
  providerMessageId: string | null;
  sentAt: string | null;
  nextAttemptAt: string;
  updatedAt: string;
  type: string;
  title: string;
  recipient: string;
};

export type IntegrityFlag = {
  kind: string;
  severity: "low" | "medium" | "high";
  summary: string;
  auctionId?: string;
  auctionTitle?: string;
  users: { id: string; handle: string | null }[];
  evidence: Record<string, unknown>;
};

export type AuditEntry = {
  id: string;
  action: string;
  actorId: string | null;
  entityType: string | null;
  entityId: string | null;
  createdAt: string;
  metadata: unknown;
};

const qs = (params: Record<string, string | number | boolean | undefined | null>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
};

const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: "POST", body });

export type AdminCategory = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  auctionCount: number;
  openAuctionCount: number;
};
export type AdminCategoryNode = AdminCategory & { subcategories: AdminCategory[] };
export type Party = {
  id: string;
  email: string;
  displayName: string | null;
  handle: string | null;
};
export type AdminOrder = {
  id: string;
  orderNumber: string;
  status: string;
  auction: { id: string; title: string; lotNumber: number };
  buyer: Party;
  seller: Party;
  hammerPrice: Money;
  buyerPremium: Money;
  total: Money;
  demoCompletedAt: string | null;
  fulfillmentMethod: string | null;
  openDisputes: number;
  createdAt: string;
};
export type AdminDispute = {
  id: string;
  status: "OPEN" | "UNDER_REVIEW" | "RESOLVED_BUYER" | "RESOLVED_SELLER" | "CLOSED";
  reason: string;
  details: string | null;
  resolution: string | null;
  resolvedAt: string | null;
  createdAt: string;
  openedBy: Party;
  openedByRole: "buyer" | "seller";
  handledBy: Party | null;
  order: {
    id: string;
    orderNumber: string;
    status: string;
    total: Money;
    auction: { id: string; title: string };
  };
};

export const adminApi = {
  analytics: (days: number) => api<Analytics>(`/admin/analytics${qs({ days })}`),
  integrity: (days = 30) => api<IntegrityFlag[]>(`/admin/integrity/bidding${qs({ days })}`),

  users: (p: { q?: string; status?: string; role?: string; verified?: string; page?: number }) =>
    api<Page<AdminUser>>(`/admin/users${qs({ ...p, limit: 20 })}`),
  user: (id: string) => api<AdminUserDetail>(`/admin/users/${id}`),
  suspend: (id: string, reason: string, level: "SUSPENDED" | "BANNED", until?: string) =>
    post(`/admin/users/${id}/suspend`, { reason, level, ...(until ? { until } : {}) }),
  unsuspend: (id: string) => post(`/admin/users/${id}/unsuspend`),
  revokeSessions: (id: string) =>
    post<{ revokedSessions: number }>(`/admin/users/${id}/sessions/revoke`),
  grantRole: (id: string, role: string) => post(`/admin/users/${id}/roles/grant`, { role }),
  revokeRole: (id: string, role: string) => post(`/admin/users/${id}/roles/revoke`, { role }),

  sellerApplications: () => api<SellerApplication[]>("/admin/sellers/applications"),
  decideSeller: (userId: string, decision: "approve" | "reject", reason?: string) =>
    post(`/admin/sellers/${userId}/decision`, { decision, ...(reason ? { reason } : {}) }),

  auctions: (p: {
    status?: string;
    category?: string;
    sellerId?: string;
    q?: string;
    page?: number;
  }) => api<Page<AdminAuction>>(`/admin/auctions${qs({ ...p, limit: 20 })}`),
  auction: (id: string) => api<AdminAuctionDetail>(`/admin/auctions/${id}`),
  reviewQueue: () => api<import("./types").AuctionDto[]>("/admin/auctions/review"),
  approve: (id: string) => post(`/admin/auctions/${id}/approve`),
  reject: (id: string, reason: string) => post(`/admin/auctions/${id}/reject`, { reason }),
  cancel: (id: string, reason: string) => post(`/admin/auctions/${id}/cancel`, { reason }),

  reports: (status?: string) => api<ReportItem[]>(`/admin/reports${qs({ status })}`),
  decideReport: (id: string, status: string, resolution?: string) =>
    post(`/admin/reports/${id}/decision`, { status, ...(resolution ? { resolution } : {}) }),

  chatMessages: (p: { auctionId?: string; status?: string; q?: string; reported?: boolean }) =>
    api<AdminChatMessage[]>(`/admin/chat/messages${qs(p)}`),
  moderateMessage: (id: string, action: "hide" | "delete" | "restore", reason?: string) =>
    post(`/admin/chat/messages/${id}/${action}`, reason ? { reason } : {}),
  restrictions: (active = true) =>
    api<ChatRestriction[]>(`/admin/chat/restrictions${qs({ active })}`),
  restrict: (
    userId: string,
    type: "MUTE" | "BAN",
    minutes?: number,
    reason?: string,
    hideRecentMessages?: boolean,
  ) =>
    post("/admin/chat/restrictions", {
      userId,
      type,
      ...(minutes ? { minutes } : {}),
      ...(reason ? { reason } : {}),
      ...(hideRecentMessages ? { hideRecentMessages } : {}),
    }),
  lift: (id: string) => api(`/admin/chat/restrictions/${id}`, { method: "DELETE" }),
  moderationLog: () => api<ModerationLogEntry[]>("/admin/chat/moderation-log"),

  announcements: () => api<Announcement[]>("/admin/notifications/announcements"),
  announce: (b: {
    title: string;
    body: string;
    audience: string;
    sendEmail: boolean;
    link?: string;
  }) => post<Announcement>("/admin/notifications/announcements", b),
  deliveries: (p: { status?: string; channel?: string }) =>
    api<{ summary: { channel: string; status: string; count: number }[]; items: Delivery[] }>(
      `/admin/notifications/deliveries${qs({ ...p, limit: 100 })}`,
    ),
  retryDelivery: (id: string) => post(`/admin/notifications/deliveries/${id}/retry`),

  audit: (action?: string) => api<AuditEntry[]>(`/admin/audit-logs${qs({ action, limit: 100 })}`),

  categories: () => api<AdminCategoryNode[]>("/admin/categories"),
  createCategory: (b: { slug: string; name: string; description?: string; parentSlug?: string }) =>
    post<{ id: string; slug: string }>("/admin/categories", b),
  updateCategory: (
    slug: string,
    b: Partial<Pick<AdminCategory, "name" | "description" | "sortOrder" | "isActive">>,
  ) => api(`/admin/categories/${slug}`, { method: "PATCH", body: b }),

  orders: (p: { status?: string | undefined; page?: number }) =>
    api<Page<AdminOrder> & { counts: Record<string, number> }>(
      `/admin/orders${qs({ ...p, limit: 20 })}`,
    ),
  disputes: (p: { status?: string | undefined; page?: number }) =>
    api<Page<AdminDispute>>(`/admin/disputes${qs({ ...p, limit: 20 })}`),
  decideDispute: (
    id: string,
    status: Exclude<AdminDispute["status"], "OPEN">,
    resolution?: string,
  ) =>
    post<{ id: string; status: string; orderStatus: string }>(`/admin/disputes/${id}/decision`, {
      status,
      ...(resolution ? { resolution } : {}),
    }),
};

export const fmtMoney = (m: Money) => {
  const digits = m.currency === "JPY" ? 0 : 2;
  const value = Number(m.minor) / 10 ** digits;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: m.currency,
    maximumFractionDigits: 0,
  }).format(value);
};

export const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—";

/** Which dashboard sections a set of permissions unlocks (mirrors the server checks). */
export function adminAccess(perms: string[] | undefined) {
  const has = (p: string) => !!perms?.includes(p);
  return {
    any: [
      "analytics:read",
      "user:read:any",
      "auction:read:any",
      "chat:moderate",
      "report:handle",
    ].some(has),
    analytics: has("analytics:read"),
    users: has("user:read:any"),
    suspend: has("user:suspend"),
    roles: has("role:assign"),
    sellers: has("seller:verify"),
    auctions: has("auction:read:any"),
    moderateAuctions: has("auction:moderate"),
    chat: has("chat:moderate"),
    reports: has("report:handle"),
    notifications: has("notification:broadcast"),
    audit: has("audit:read"),
    ai: has("ai:admin"),
    categories: has("category:manage"),
    orders: has("order:read:any"),
    disputes: has("dispute:handle"),
  };
}
export type AdminAccess = ReturnType<typeof adminAccess>;

/**
 * True when the signed-in user may open the staff dashboard — derived only from the
 * server-provided permission list (RBAC), never from emails or role names. `user` is null
 * until the session is restored, so the link never flashes for unauthorised visitors. The
 * server still authorises every /admin request.
 */
export function canOpenAdmin(user: { permissions?: string[] | undefined } | null): boolean {
  return Boolean(user) && adminAccess(user?.permissions).any;
}
