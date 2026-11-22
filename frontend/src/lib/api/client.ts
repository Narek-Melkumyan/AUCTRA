/**
 * HTTP client for the AUCTRA API (VITE_API_MODE=api).
 *
 * Token handling:
 * - The access token lives in memory only (never localStorage/sessionStorage).
 * - The refresh token is an HttpOnly, SameSite=Strict cookie scoped to /api/auth that
 *   JavaScript cannot read. Refresh/login/logout send it with `credentials: "include"`.
 * - Those cookie endpoints also require a CSRF token, fetched from /api/auth/csrf and
 *   echoed in the X-CSRF-Token header.
 * - Refreshes are single-flight: concurrent 401s share one refresh request.
 */
export const API_URL = (
  (import.meta.env["VITE_API_URL"] as string | undefined) ?? "http://localhost:4000/api"
).replace(/\/$/, "");
export const SOCKET_URL = new URL(API_URL).origin;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

let accessToken: string | null = null;
let csrfToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
const tokenListeners = new Set<(token: string | null) => void>();

export function getAccessToken() {
  return accessToken;
}

export function setAccessToken(token: string | null) {
  accessToken = token;
  tokenListeners.forEach((l) => l(token));
}

/** Notified when the user signs in/out or the access token is refreshed. */
export function onAccessToken(listener: (token: string | null) => void) {
  tokenListeners.add(listener);
  return () => tokenListeners.delete(listener);
}

async function ensureCsrf(force = false): Promise<string> {
  if (csrfToken && !force) return csrfToken;
  const res = await fetch(`${API_URL}/auth/csrf`, { credentials: "include" });
  if (!res.ok) throw new ApiError(res.status, "CSRF_UNAVAILABLE", "Could not reach the server.");
  csrfToken = ((await res.json()) as { csrfToken: string }).csrfToken;
  return csrfToken;
}

async function parseError(res: Response): Promise<ApiError> {
  let body: { code?: string; message?: string; details?: unknown } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* non-JSON error */
  }
  return new ApiError(
    res.status,
    body.code ?? "HTTP_" + res.status,
    body.message ?? "Request failed.",
    body.details,
  );
}

type Options = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  auth?: boolean;
};

/** Calls a cookie-authenticated auth endpoint with CSRF protection (retries once on a stale CSRF token). */
export async function authCall<T>(path: string, body?: unknown): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const csrf = await ensureCsrf(attempt > 0);
    const res = await fetch(`${API_URL}${path}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: body === undefined ? null : JSON.stringify(body),
    });
    if (res.status === 403 && attempt === 0) {
      const err = await parseError(res);
      if (/CSRF/i.test(err.message)) continue;
      throw err;
    }
    if (!res.ok) throw await parseError(res);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }
  throw new ApiError(403, "CSRF_FAILED", "Security check failed. Reload the page and try again.");
}

export type AuthResponse = {
  user: import("./types").MeDto;
  accessToken: string;
  accessTokenExpiresAt: string;
};

/** Exchanges the refresh cookie for a new access token. Resolves false when signed out. */
export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // 204 (undefined) = no refresh cookie at all: a signed-out visitor.
        const r = await authCall<AuthResponse | undefined>("/auth/refresh");
        if (!r) {
          setAccessToken(null);
          return false;
        }
        setAccessToken(r.accessToken);
        lastUser = r.user;
        return true;
      } catch (err) {
        // Another tab refreshed at the same moment: the browser now holds the newer cookie.
        if (err instanceof ApiError && err.code === "REFRESH_IN_PROGRESS") {
          await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
          continue;
        }
        setAccessToken(null);
        return false;
      }
    }
    return false;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

let lastUser: import("./types").MeDto | null = null;
/** The user returned by the most recent successful refresh. */
export const lastRefreshedUser = () => lastUser;

/** JSON request with bearer auth and one transparent refresh on an expired token. */
export async function api<T>(path: string, opts: Options = {}): Promise<T> {
  const send = () =>
    fetch(`${API_URL}${path}`, {
      method: opts.method ?? "GET",
      headers: {
        ...(opts.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...opts.headers,
      },
      body: opts.body === undefined ? null : JSON.stringify(opts.body),
    });
  let res = await send();
  if (res.status === 401 && accessToken) {
    if (await refreshSession()) res = await send();
  }
  if (!res.ok) throw await parseError(res);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/**
 * Multipart upload with progress (fetch cannot report upload progress). Uses the same
 * in-memory bearer token and one transparent refresh as `api()`.
 */
export async function uploadForm<T>(
  path: string,
  form: FormData,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<T> {
  const send = () =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${API_URL}${path}`);
      if (accessToken) xhr.setRequestHeader("Authorization", `Bearer ${accessToken}`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress?.(e.loaded / e.total);
      };
      xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
      xhr.onerror = () =>
        reject(new ApiError(0, "NETWORK_ERROR", "Upload failed: could not reach the server."));
      xhr.onabort = () => reject(new ApiError(0, "ABORTED", "Upload cancelled."));
      signal?.addEventListener("abort", () => xhr.abort(), { once: true });
      xhr.send(form);
    });
  let res = await send();
  if (res.status === 401 && accessToken && (await refreshSession())) {
    onProgress?.(0);
    res = await send();
  }
  let body: { code?: string; message?: string; details?: unknown } = {};
  try {
    body = res.body ? (JSON.parse(res.body) as typeof body) : {};
  } catch {
    /* non-JSON */
  }
  if (res.status < 200 || res.status >= 300)
    throw new ApiError(
      res.status,
      body.code ?? "HTTP_" + res.status,
      body.message ?? "Upload failed.",
      body.details,
    );
  return body as T;
}

/** Converts "123456" minor units to a display number of major units (exact up to 2^53). */
export function minorToMajor(minor: string, currency = "USD"): number {
  const digits = currency === "JPY" ? 0 : 2;
  return Number(minor) / 10 ** digits;
}

/** Converts a major-unit amount the user typed to an exact minor-unit string. */
export function majorToMinor(amount: number, currency = "USD"): string {
  const digits = currency === "JPY" ? 0 : 2;
  if (!Number.isFinite(amount) || amount < 0) throw new RangeError("invalid amount");
  const [whole, frac = ""] = amount.toFixed(digits).split(".");
  return BigInt(`${whole}${frac}`).toString();
}
