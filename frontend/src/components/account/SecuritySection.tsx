import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Laptop, ShieldCheck, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { btn, btnGhost, input } from "@/components/account/AccountLayout";
import {
  changePassword,
  describeDevice,
  listSessions,
  revokeSession,
  signOutEverywhere,
  type SessionDto,
} from "@/lib/api/account";
import type { Profile } from "@/lib/demo-session";
import { cn } from "@/lib/utils";

const when = (iso: string) =>
  new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

/** API mode only: email status, password change and active device sessions. */
export function SecuritySection({ user }: { user: Profile }) {
  const nav = useNavigate();
  const [sessions, setSessions] = useState<SessionDto[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(false);
    listSessions()
      .then(setSessions)
      .catch(() => setLoadError(true));
  }, []);
  useEffect(load, [load]);

  const submitPassword = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const current = String(f.get("current") ?? "");
    const next = String(f.get("next") ?? "");
    if (next.length < 10) {
      toast.error("New password must be at least 10 characters.");
      return;
    }
    if (next !== String(f.get("confirm") ?? "")) {
      toast.error("The new passwords don't match.");
      return;
    }
    setBusy("password");
    const r = await changePassword(current, next);
    setBusy(null);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    form.reset();
    toast.success(
      r.data.revokedSessions
        ? `Password changed. ${r.data.revokedSessions} other device(s) signed out.`
        : "Password changed.",
    );
    load();
  };

  return (
    <section className="mt-10 max-w-xl space-y-8" aria-labelledby="security-h">
      <h2 id="security-h" className="text-sm font-medium">
        Security
      </h2>

      <div className="flex items-start gap-3 rounded-lg border bg-card p-4 text-sm">
        {user.emailVerified ? (
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
        ) : (
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-live" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            {user.emailVerified ? "Email verified" : "Email not verified"}
          </p>
          <p className="text-muted-foreground">
            {user.emailVerified
              ? `${user.email} is confirmed.`
              : "Verify your address to bid and chat in auction rooms."}
          </p>
        </div>
        {!user.emailVerified && (
          <Link to="/verify-email" search={{ token: "", delivery: "" }} className={btn}>
            Verify
          </Link>
        )}
      </div>

      <form onSubmit={(e) => void submitPassword(e)} className="space-y-3">
        <h3 className="text-sm font-medium">Change password</h3>
        <label className="block text-sm">
          Current password
          <input
            name="current"
            type="password"
            autoComplete="current-password"
            required
            className={cn(input, "mt-1.5")}
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            New password
            <input
              name="next"
              type="password"
              autoComplete="new-password"
              minLength={10}
              maxLength={128}
              required
              className={cn(input, "mt-1.5")}
            />
          </label>
          <label className="block text-sm">
            Confirm new password
            <input
              name="confirm"
              type="password"
              autoComplete="new-password"
              required
              className={cn(input, "mt-1.5")}
            />
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          Changing your password signs out every other device and emails you a security alert.
        </p>
        <button className={btn} disabled={busy === "password"}>
          {busy === "password" ? "Saving…" : "Change password"}
        </button>
      </form>

      <div>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-medium">Active sessions</h3>
          <button
            className={btnGhost}
            disabled={busy === "all"}
            onClick={() => {
              if (!confirm("Sign out of AUCTRA on every device, including this one?")) return;
              setBusy("all");
              void signOutEverywhere().then((r) => {
                setBusy(null);
                if (!r.ok) {
                  toast.error(r.error);
                  return;
                }
                toast.success(`Signed out of ${r.data.revokedSessions} session(s).`);
                void nav({ to: "/login", search: { mode: "in" } });
              });
            }}
          >
            Sign out everywhere
          </button>
        </div>
        {loadError ? (
          <p className="rounded-lg border p-4 text-sm text-muted-foreground">
            Couldn't load sessions.{" "}
            <button className="underline" onClick={load}>
              Retry
            </button>
          </p>
        ) : !sessions ? (
          <div className="h-24 animate-pulse rounded-lg border bg-muted/40" aria-label="Loading" />
        ) : (
          <ul className="divide-y rounded-lg border bg-card">
            {sessions.map((s) => (
              <li key={s.id} className="flex items-center gap-3 p-3 text-sm">
                <Laptop className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {describeDevice(s.userAgent)}
                    {s.current && (
                      <span className="ml-2 rounded bg-success/15 px-1.5 py-0.5 text-[11px] text-success">
                        This device
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Signed in {when(s.createdAt)} · active {when(s.lastActiveAt)}
                    {s.networkFingerprint && ` · network ${s.networkFingerprint}`}
                  </p>
                </div>
                {!s.current && (
                  <button
                    className={btnGhost}
                    disabled={busy === s.id}
                    onClick={() => {
                      setBusy(s.id);
                      void revokeSession(s.id).then((r) => {
                        setBusy(null);
                        if (!r.ok) toast.error(r.error);
                        else {
                          toast.success("Device signed out");
                          setSessions((list) => list?.filter((x) => x.id !== s.id) ?? null);
                        }
                      });
                    }}
                  >
                    Sign out
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
