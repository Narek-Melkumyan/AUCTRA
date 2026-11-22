import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { input } from "@/components/account/AccountLayout";
import { describeDevice } from "@/lib/api/account";
import { adminApi, fmtDate, fmtMoney, type AdminAccess } from "@/lib/api/admin";
import { cn } from "@/lib/utils";
import {
  ConfirmDialog,
  EmptyRow,
  ErrorState,
  Loading,
  Pager,
  Pill,
  Section,
  btnDanger,
  btnSm,
  select,
  td,
  th,
  useAdminAction,
  useConfirm,
} from "./shared";

const ROLES = ["USER", "SELLER", "MODERATOR", "ADMIN", "SUPER_ADMIN"];

export function UsersPanel({ access, me }: { access: AdminAccess; me: string | undefined }) {
  const [filters, setFilters] = useState({ q: "", status: "", role: "", verified: "" });
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["admin", "users", filters, page],
    queryFn: () => adminApi.users({ ...filters, page }),
    placeholderData: keepPreviousData,
  });
  const set = (k: keyof typeof filters, v: string) => {
    setPage(1);
    setFilters((f) => ({ ...f, [k]: v }));
  };

  return (
    <Section
      title="Users"
      description="Search accounts, review activity and act on them. Every action is audit-logged."
      actions={
        <>
          <input
            value={filters.q}
            onChange={(e) => set("q", e.target.value)}
            placeholder="Search email, handle or name"
            aria-label="Search users"
            className={cn(input, "h-9 w-56")}
          />
          <select
            aria-label="Status"
            value={filters.status}
            onChange={(e) => set("status", e.target.value)}
            className={select}
          >
            <option value="">Any status</option>
            {["ACTIVE", "SUSPENDED", "BANNED"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <select
            aria-label="Role"
            value={filters.role}
            onChange={(e) => set("role", e.target.value)}
            className={select}
          >
            <option value="">Any role</option>
            {ROLES.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
          <select
            aria-label="Verification"
            value={filters.verified}
            onChange={(e) => set("verified", e.target.value)}
            className={select}
          >
            <option value="">Any email</option>
            <option value="true">Verified</option>
            <option value="false">Unverified</option>
          </select>
        </>
      }
    >
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorState error={q.error} retry={() => void q.refetch()} />
      ) : q.data.items.length === 0 ? (
        <EmptyRow>No users match these filters.</EmptyRow>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="border-b">
                <tr>
                  {[
                    "User",
                    "Roles",
                    "Status",
                    "Email",
                    "Bids",
                    "Listings",
                    "Joined",
                    "Last sign-in",
                  ].map((h) => (
                    <th key={h} className={th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((u) => (
                  <tr
                    key={u.id}
                    onClick={() => setOpenId(u.id)}
                    className="cursor-pointer border-b last:border-0 hover:bg-accent"
                  >
                    <td className={td}>
                      <p className="font-medium">{u.displayName ?? "—"}</p>
                      <p className="text-xs text-muted-foreground">
                        @{u.handle} · {u.email}
                      </p>
                    </td>
                    <td className={cn(td, "text-xs")}>{u.roles.join(", ")}</td>
                    <td className={td}>
                      <Pill value={u.status} />
                    </td>
                    <td className={cn(td, "text-xs")}>
                      {u.emailVerified ? "verified" : "unverified"}
                    </td>
                    <td className={cn(td, "tabular")}>{u.bids}</td>
                    <td className={cn(td, "tabular")}>{u.auctions}</td>
                    <td className={cn(td, "text-xs text-muted-foreground")}>
                      {fmtDate(u.createdAt)}
                    </td>
                    <td className={cn(td, "text-xs text-muted-foreground")}>
                      {fmtDate(u.lastLoginAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={q.data.page} total={q.data.total} limit={q.data.limit} onPage={setPage} />
        </>
      )}
      <Sheet open={!!openId} onOpenChange={(o) => !o && setOpenId(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          {openId && <UserDetail id={openId} access={access} isSelf={openId === me} />}
        </SheetContent>
      </Sheet>
    </Section>
  );
}

function UserDetail({ id, access, isSelf }: { id: string; access: AdminAccess; isSelf: boolean }) {
  const q = useQuery({ queryKey: ["admin", "user", id], queryFn: () => adminApi.user(id) });
  const invalidate = [
    ["admin", "user", id],
    ["admin", "users"],
  ];
  const suspend = useAdminAction(
    (a: { reason: string; level: "SUSPENDED" | "BANNED" }) =>
      adminApi.suspend(id, a.reason, a.level),
    { success: "Account updated", invalidate },
  );
  const unsuspend = useAdminAction(() => adminApi.unsuspend(id), {
    success: "Account reactivated",
    invalidate,
  });
  const revoke = useAdminAction(() => adminApi.revokeSessions(id), {
    success: "Signed out of all devices",
    invalidate,
  });
  const role = useAdminAction(
    (a: { role: string; grant: boolean }) =>
      a.grant ? adminApi.grantRole(id, a.role) : adminApi.revokeRole(id, a.role),
    { success: "Roles updated", invalidate },
  );
  const mute = useAdminAction(
    (a: { type: "MUTE" | "BAN"; reason: string }) =>
      adminApi.restrict(id, a.type, a.type === "MUTE" ? 60 : undefined, a.reason, a.type === "BAN"),
    { success: "Chat restriction applied", invalidate },
  );
  const confirm = useConfirm<"SUSPENDED" | "BANNED" | "MUTE" | "CHAT_BAN">();

  if (q.isPending) return <Loading rows={8} />;
  if (q.isError) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const u = q.data;
  const restricted = u.status === "SUSPENDED" || u.status === "BANNED";

  return (
    <div className="space-y-6">
      <div>
        <SheetTitle>{u.profile?.displayName ?? u.email}</SheetTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          @{u.profile?.handle} · {u.email}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Pill value={u.status} />
          {u.roles.map((r) => (
            <span key={r} className="rounded-full border px-2 py-0.5 text-[11px]">
              {r}
            </span>
          ))}
          {!u.emailVerified && <Pill value="UNVERIFIED" />}
          {u.chatRestriction && (
            <Pill value={u.chatRestriction.type === "BAN" ? "BANNED" : "SUSPENDED"} />
          )}
        </div>
        {u.suspensionReason && (
          <p className="mt-2 text-sm text-live">Reason: {u.suspensionReason}</p>
        )}
      </div>

      <dl className="grid grid-cols-3 gap-3 text-center text-sm">
        {[
          ["Bids", u.counts.bids],
          ["Listings", u.counts.auctionsSelling],
          ["Won", u.counts.auctionsWon],
          ["Chat msgs", u.counts.chatMessages],
          ["Orders", u.counts.ordersAsBuyer],
          ["Reports vs.", u.reportsAgainst],
        ].map(([k, v]) => (
          <div key={k as string} className="rounded-xl bg-secondary p-3">
            <dd className="text-lg font-semibold tabular">{v}</dd>
            <dt className="text-xs text-muted-foreground">{k}</dt>
          </div>
        ))}
      </dl>

      {!isSelf && (access.suspend || access.chat) && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Actions</p>
          <div className="flex flex-wrap gap-2">
            {access.suspend &&
              (restricted ? (
                <button
                  className={btnSm}
                  disabled={unsuspend.isPending}
                  onClick={() => unsuspend.mutate(undefined)}
                >
                  Reactivate account
                </button>
              ) : (
                <>
                  <button className={btnDanger} onClick={() => confirm.open("SUSPENDED")}>
                    Suspend
                  </button>
                  <button className={btnDanger} onClick={() => confirm.open("BANNED")}>
                    Ban
                  </button>
                </>
              ))}
            {access.suspend && (
              <button
                className={btnSm}
                disabled={revoke.isPending}
                onClick={() => revoke.mutate(undefined)}
              >
                Sign out all devices
              </button>
            )}
            {access.chat && !u.chatRestriction && (
              <>
                <button className={btnSm} onClick={() => confirm.open("MUTE")}>
                  Mute in chat (1h)
                </button>
                <button className={btnDanger} onClick={() => confirm.open("CHAT_BAN")}>
                  Ban from chat
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {access.roles && !isSelf && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Roles (super-admin)</p>
          <div className="flex flex-wrap gap-2">
            {ROLES.filter((r) => r !== "USER").map((r) => {
              const has = u.roles.includes(r);
              return (
                <button
                  key={r}
                  className={cn(btnSm, has && "border-primary bg-primary/10")}
                  disabled={role.isPending}
                  onClick={() => {
                    if (
                      confirm_(`${has ? "Remove" : "Grant"} ${r} ${has ? "from" : "to"} this user?`)
                    )
                      role.mutate({ role: r, grant: !has });
                  }}
                >
                  {has ? "✓ " : "+ "}
                  {r}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {u.sessions && (
        <div>
          <p className="mb-2 text-sm font-medium">Active sessions</p>
          {u.sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active sessions.</p>
          ) : (
            <ul className="divide-y rounded-lg border text-sm">
              {u.sessions.map((s) => (
                <li key={s.id} className="p-3">
                  {describeDevice(s.userAgent)}
                  <span className="block text-xs text-muted-foreground">
                    Active {fmtDate(s.lastActiveAt)} · network {s.network ?? "—"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div>
        <p className="mb-2 text-sm font-medium">Recent bids</p>
        {u.recentBids.length === 0 ? (
          <p className="text-sm text-muted-foreground">No bids.</p>
        ) : (
          <ul className="divide-y rounded-lg border text-sm">
            {u.recentBids.map((b) => (
              <li key={b.id} className="flex justify-between gap-3 p-3">
                <Link
                  to="/room/$id"
                  params={{ id: b.auctionId }}
                  className="min-w-0 truncate hover:underline"
                >
                  {b.auctionTitle}
                </Link>
                <span className="shrink-0 tabular">{fmtMoney(b.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <p className="mb-2 text-sm font-medium">Activity</p>
        <ul className="max-h-72 divide-y overflow-y-auto rounded-lg border text-xs">
          {u.activity.map((a) => (
            <li key={a.id} className="flex justify-between gap-3 p-2.5">
              <span className="font-mono">{a.action}</span>
              <span className="text-muted-foreground">
                {a.actorId && a.actorId !== u.id ? "by staff · " : ""}
                {fmtDate(a.createdAt)}
              </span>
            </li>
          ))}
          {u.activity.length === 0 && (
            <li className="p-3 text-muted-foreground">No recorded activity.</li>
          )}
        </ul>
      </div>

      <ConfirmDialog
        {...confirm.props}
        title={
          confirm.target === "BANNED"
            ? "Ban this account?"
            : confirm.target === "SUSPENDED"
              ? "Suspend this account?"
              : confirm.target === "MUTE"
                ? "Mute in auction chat for 1 hour?"
                : "Ban from auction chat?"
        }
        description={
          confirm.target === "BANNED"
            ? "Signs the user out everywhere and blocks sign-in."
            : confirm.target === "SUSPENDED"
              ? "The user can sign in and browse but cannot bid, sell or chat."
              : confirm.target === "CHAT_BAN"
                ? "They can no longer post in any auction chat; their messages from the last 24h are hidden."
                : "They can read chat but not post for an hour."
        }
        reasonLabel="Reason (shown in the audit log)"
        reasonRequired
        danger={confirm.target !== "MUTE"}
        confirmLabel="Confirm"
        pending={suspend.isPending || mute.isPending}
        onConfirm={(reason) => {
          const t = confirm.target;
          confirm.close();
          if (t === "SUSPENDED" || t === "BANNED") suspend.mutate({ reason, level: t });
          else if (t === "MUTE") mute.mutate({ type: "MUTE", reason });
          else if (t === "CHAT_BAN") mute.mutate({ type: "BAN", reason });
        }}
      />
    </div>
  );
}

const confirm_ = (msg: string) => (typeof window === "undefined" ? false : window.confirm(msg));
