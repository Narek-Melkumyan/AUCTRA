/**
 * Account & security calls (API mode): email verification, sessions, password change.
 */
import { ApiError, api, authCall, setAccessToken } from "./client";
import { getUser, setApiSession } from "@/lib/demo-session";
import type { MeDto } from "./types";

export type Outcome<T = void> =
  | ({ ok: true } & (T extends void ? unknown : { data: T }))
  | { ok: false; error: string; code?: string; details?: unknown };

const failure = (err: unknown, fallback: string) =>
  err instanceof ApiError
    ? { ok: false as const, error: err.message, code: err.code, details: err.details }
    : { ok: false as const, error: fallback };

export type EmailDelivery = { delivered: boolean; providerConfigured: boolean; reason?: string };

function markVerifiedLocally() {
  const u = getUser();
  if (u) setApiSession({ user: { ...u, emailVerified: true } });
}

export async function verifyEmailLink(token: string): Promise<Outcome> {
  try {
    await api("/auth/verify-email", { method: "POST", body: { token } });
    markVerifiedLocally();
    return { ok: true };
  } catch (err) {
    return failure(err, "This link is invalid or has expired.");
  }
}

export async function verifyEmailCode(code: string, email?: string): Promise<Outcome> {
  try {
    await api("/auth/verify-email/code", {
      method: "POST",
      body: email ? { code, email } : { code },
    });
    markVerifiedLocally();
    return { ok: true };
  } catch (err) {
    return failure(err, "Could not verify the code. Please try again.");
  }
}

export async function resendVerification(): Promise<
  Outcome<{ alreadyVerified: boolean; email?: EmailDelivery; expiresInMinutes?: number }>
> {
  try {
    const r = await api<{
      sent: boolean;
      alreadyVerified: boolean;
      email?: EmailDelivery;
      expiresInMinutes?: number;
    }>("/auth/resend-verification", { method: "POST" });
    if (r.alreadyVerified) markVerifiedLocally();
    return { ok: true, data: r };
  } catch (err) {
    return failure(err, "Could not send a new email right now.");
  }
}

export async function refreshMe(): Promise<MeDto | null> {
  try {
    const me = await api<MeDto>("/auth/me");
    const u = getUser();
    if (u)
      setApiSession({
        user: {
          ...u,
          emailVerified: me.emailVerified,
          roles: me.roles,
          permissions: me.permissions,
        },
      });
    return me;
  } catch {
    return null;
  }
}

export type SessionDto = {
  id: string;
  current: boolean;
  userAgent: string | null;
  networkFingerprint: string | null;
  createdAt: string;
  lastActiveAt: string;
  expiresAt: string;
};

export const listSessions = () => api<SessionDto[]>("/auth/sessions");

export async function revokeSession(id: string): Promise<Outcome> {
  try {
    await api(`/auth/sessions/${id}`, { method: "DELETE" });
    return { ok: true };
  } catch (err) {
    return failure(err, "Could not sign out that device.");
  }
}

/** Revokes every session including this one, then clears local state. */
export async function signOutEverywhere(): Promise<Outcome<{ revokedSessions: number }>> {
  try {
    const r = await authCall<{ revokedSessions: number }>("/auth/logout-all");
    setAccessToken(null);
    setApiSession({ user: null, orders: [] });
    return { ok: true, data: r };
  } catch (err) {
    return failure(err, "Could not sign out everywhere.");
  }
}

export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<Outcome<{ revokedSessions: number }>> {
  try {
    const r = await api<{ revokedSessions: number }>("/auth/change-password", {
      method: "POST",
      body: { currentPassword, newPassword },
    });
    return { ok: true, data: r };
  } catch (err) {
    if (err instanceof ApiError && err.code === "VALIDATION_FAILED")
      return { ok: false, error: "New password must be 10–128 characters." };
    return failure(err, "Could not change the password.");
  }
}

/** Human-readable device label from a user-agent string. */
export function describeDevice(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
      ? "Chrome"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Safari\//.test(ua)
          ? "Safari"
          : /curl|node|undici|supertest/i.test(ua)
            ? "API client"
            : "Browser";
  const os = /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return os ? `${browser} on ${os}` : browser;
}
