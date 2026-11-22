import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { input } from "@/components/account/AccountLayout";
import { adminApi, fmtDate, type AdminAccess, type ReportItem } from "@/lib/api/admin";
import { cn } from "@/lib/utils";
import {
  ConfirmDialog,
  EmptyRow,
  ErrorState,
  Loading,
  Pill,
  Section,
  btnDanger,
  btnSm,
  select,
  useAdminAction,
  useConfirm,
} from "./shared";

export function ModerationPanel({ access }: { access: AdminAccess }) {
  return (
    <div className="space-y-6">
      {access.reports && <Reports canModerateChat={access.chat} />}
      {access.chat && (
        <>
          <ChatMessages />
          <div className="grid gap-6 xl:grid-cols-2">
            <Restrictions />
            <ModerationLog />
          </div>
        </>
      )}
    </div>
  );
}

const inv = [
  ["admin", "reports"],
  ["admin", "chat"],
  ["admin", "restrictions"],
  ["admin", "modlog"],
];

function Reports({ canModerateChat }: { canModerateChat: boolean }) {
  const [status, setStatus] = useState("");
  const q = useQuery({
    queryKey: ["admin", "reports", status],
    queryFn: () => adminApi.reports(status || undefined),
  });
  const decide = useAdminAction(
    (a: { id: string; status: string; resolution?: string }) =>
      adminApi.decideReport(a.id, a.status, a.resolution),
    { success: "Report updated", invalidate: inv },
  );
  const hide = useAdminAction(
    (a: { messageId: string; reportId: string }) =>
      adminApi
        .moderateMessage(a.messageId, "hide", "Reported and reviewed")
        .then(() => adminApi.decideReport(a.reportId, "RESOLVED", "Message hidden")),
    { success: "Message hidden and report resolved", invalidate: inv },
  );
  const dismiss = useConfirm<ReportItem>();
  return (
    <Section
      title="Reports"
      description="User reports about chat messages, listings and accounts."
      actions={
        <select
          aria-label="Report status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className={select}
        >
          <option value="">Open & under review</option>
          {["RESOLVED", "DISMISSED"].map((s) => (
            <option key={s} value={s}>
              {s.toLowerCase()}
            </option>
          ))}
        </select>
      }
    >
      {q.isPending ? (
        <Loading rows={2} />
      ) : q.isError ? (
        <ErrorState error={q.error} retry={() => void q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyRow>No reports here. 🎉</EmptyRow>
      ) : (
        <ul className="divide-y">
          {q.data.map((r) => {
            const t = r.target as Record<string, string> | null;
            return (
              <li key={r.id} className="space-y-2 px-5 py-4 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill value={r.status} />
                  <span className="font-medium">{r.reason}</span>
                  <span className="text-xs text-muted-foreground">
                    {r.targetType.replace("_", " ").toLowerCase()} · by @{r.reporter} ·{" "}
                    {fmtDate(r.createdAt)}
                  </span>
                </div>
                {r.details && <p className="text-muted-foreground">“{r.details}”</p>}
                {t?.["kind"] === "chat" && (
                  <div className="rounded-lg bg-secondary p-3">
                    <p className="text-xs text-muted-foreground">
                      @{t["author"]} in{" "}
                      <Link to="/room/$id" params={{ id: t["auctionId"]! }} className="underline">
                        {t["auctionTitle"]}
                      </Link>{" "}
                      · <Pill value={t["status"]!} />
                    </p>
                    <p className="mt-1 whitespace-pre-wrap break-words">{t["body"]}</p>
                  </div>
                )}
                {t?.["kind"] === "auction" && (
                  <p>
                    Listing:{" "}
                    <Link to="/room/$id" params={{ id: t["id"]! }} className="underline">
                      {t["title"]}
                    </Link>
                  </p>
                )}
                {t?.["kind"] === "user" && (
                  <p>
                    Account: @{t["handle"]} ({t["status"]?.toLowerCase()})
                  </p>
                )}
                {!t && (
                  <p className="text-xs text-muted-foreground">
                    The reported item no longer exists.
                  </p>
                )}
                {r.resolution && <p className="text-xs">Resolution: {r.resolution}</p>}
                {(r.status === "OPEN" || r.status === "UNDER_REVIEW") && (
                  <div className="flex flex-wrap gap-2">
                    {canModerateChat && t?.["kind"] === "chat" && t["status"] === "VISIBLE" && (
                      <button
                        className={btnDanger}
                        disabled={hide.isPending}
                        onClick={() => hide.mutate({ messageId: r.targetId, reportId: r.id })}
                      >
                        Hide message & resolve
                      </button>
                    )}
                    {r.status === "OPEN" && (
                      <button
                        className={btnSm}
                        onClick={() => decide.mutate({ id: r.id, status: "UNDER_REVIEW" })}
                      >
                        Mark under review
                      </button>
                    )}
                    <button
                      className={btnSm}
                      onClick={() =>
                        decide.mutate({ id: r.id, status: "RESOLVED", resolution: "Handled" })
                      }
                    >
                      Resolve
                    </button>
                    <button className={btnSm} onClick={() => dismiss.open(r)}>
                      Dismiss
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog
        {...dismiss.props}
        title="Dismiss this report?"
        description="Use this when the report doesn't break the rules. It's recorded in the moderation history."
        reasonLabel="Note (optional)"
        confirmLabel="Dismiss"
        onConfirm={(reason) => {
          const r = dismiss.target!;
          dismiss.close();
          decide.mutate({
            id: r.id,
            status: "DISMISSED",
            ...(reason ? { resolution: reason } : {}),
          });
        }}
      />
    </Section>
  );
}

function ChatMessages() {
  const [f, setF] = useState({ q: "", status: "", reported: false });
  const q = useQuery({
    queryKey: ["admin", "chat", f],
    queryFn: () =>
      adminApi.chatMessages({
        ...(f.q ? { q: f.q } : {}),
        ...(f.status ? { status: f.status } : {}),
        ...(f.reported ? { reported: true } : {}),
      }),
    refetchInterval: 15_000,
  });
  const act = useAdminAction(
    (a: { id: string; action: "hide" | "delete" | "restore" }) =>
      adminApi.moderateMessage(a.id, a.action, "Moderated from the dashboard"),
    { success: "Message updated", invalidate: inv },
  );
  const restrict = useAdminAction(
    (a: { userId: string; type: "MUTE" | "BAN"; reason: string }) =>
      adminApi.restrict(
        a.userId,
        a.type,
        a.type === "MUTE" ? 60 : undefined,
        a.reason,
        a.type === "BAN",
      ),
    { success: "Restriction applied", invalidate: inv },
  );
  const confirm = useConfirm<{ userId: string; type: "MUTE" | "BAN"; handle: string }>();
  return (
    <Section
      title="Auction chat"
      description="Recent messages across all rooms (refreshes every 15s)."
      actions={
        <>
          <input
            value={f.q}
            onChange={(e) => setF((x) => ({ ...x, q: e.target.value }))}
            placeholder="Search text"
            aria-label="Search chat"
            className={cn(input, "h-9 w-40")}
          />
          <select
            aria-label="Message status"
            value={f.status}
            onChange={(e) => setF((x) => ({ ...x, status: e.target.value }))}
            className={select}
          >
            <option value="">Any status</option>
            {["VISIBLE", "HIDDEN", "DELETED"].map((s) => (
              <option key={s} value={s}>
                {s.toLowerCase()}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={f.reported}
              onChange={(e) => setF((x) => ({ ...x, reported: e.target.checked }))}
            />
            Reported only
          </label>
        </>
      }
    >
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorState error={q.error} retry={() => void q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyRow>No messages.</EmptyRow>
      ) : (
        <ul className="max-h-[520px] divide-y overflow-y-auto">
          {q.data.map((m) => (
            <li key={m.id} className="flex flex-wrap items-start gap-3 px-5 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">
                  @{m.author.handle}
                  {m.author.isSeller && " (seller)"} ·{" "}
                  <Link to="/room/$id" params={{ id: m.auctionId }} className="underline">
                    {m.auctionTitle}
                  </Link>{" "}
                  · {fmtDate(m.createdAt)} {m.status !== "VISIBLE" && <Pill value={m.status} />}
                  {m.openReports > 0 && (
                    <span className="ml-1 rounded bg-live/15 px-1 text-[10px] font-semibold text-live">
                      {m.openReports} report{m.openReports > 1 ? "s" : ""}
                    </span>
                  )}
                </p>
                <p
                  className={cn(
                    "mt-0.5 whitespace-pre-wrap break-words",
                    m.status !== "VISIBLE" && "text-muted-foreground line-through",
                  )}
                >
                  {m.body}
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {m.status === "VISIBLE" ? (
                  <button
                    className={btnSm}
                    onClick={() => act.mutate({ id: m.id, action: "hide" })}
                  >
                    Hide
                  </button>
                ) : (
                  <button
                    className={btnSm}
                    onClick={() => act.mutate({ id: m.id, action: "restore" })}
                  >
                    Restore
                  </button>
                )}
                {m.status !== "DELETED" && (
                  <button
                    className={btnDanger}
                    onClick={() => act.mutate({ id: m.id, action: "delete" })}
                  >
                    Delete
                  </button>
                )}
                {!m.author.isStaff && (
                  <>
                    <button
                      className={btnSm}
                      onClick={() =>
                        confirm.open({ userId: m.authorId, type: "MUTE", handle: m.author.handle })
                      }
                    >
                      Mute 1h
                    </button>
                    <button
                      className={btnDanger}
                      onClick={() =>
                        confirm.open({ userId: m.authorId, type: "BAN", handle: m.author.handle })
                      }
                    >
                      Ban
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        {...confirm.props}
        title={
          confirm.target?.type === "BAN"
            ? `Ban @${confirm.target.handle} from chat?`
            : `Mute @${confirm.target?.handle} for 1 hour?`
        }
        description={
          confirm.target?.type === "BAN"
            ? "Also hides their messages from the last 24 hours."
            : undefined
        }
        reasonLabel="Reason"
        reasonRequired
        danger={confirm.target?.type === "BAN"}
        confirmLabel="Apply"
        onConfirm={(reason) => {
          const t = confirm.target!;
          confirm.close();
          restrict.mutate({ userId: t.userId, type: t.type, reason });
        }}
      />
    </Section>
  );
}

function Restrictions() {
  const [active, setActive] = useState(true);
  const q = useQuery({
    queryKey: ["admin", "restrictions", active],
    queryFn: () => adminApi.restrictions(active),
  });
  const lift = useAdminAction((id: string) => adminApi.lift(id), {
    success: "Restriction lifted",
    invalidate: inv,
  });
  return (
    <Section
      title="Chat restrictions"
      actions={
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />{" "}
          Active only
        </label>
      }
    >
      {q.isPending ? (
        <Loading rows={2} />
      ) : q.isError ? (
        <ErrorState error={q.error} />
      ) : q.data.length === 0 ? (
        <EmptyRow>No {active ? "active " : ""}restrictions.</EmptyRow>
      ) : (
        <ul className="divide-y">
          {q.data.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
              <Pill value={r.type === "BAN" ? "BANNED" : "SUSPENDED"} />
              <div className="min-w-0 flex-1">
                <p>
                  @{r.handle} <span className="text-xs text-muted-foreground">{r.reason}</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {r.type === "MUTE" ? `until ${fmtDate(r.expiresAt)}` : "until lifted"} · by @
                  {r.createdBy}
                  {r.revokedAt && ` · lifted ${fmtDate(r.revokedAt)}`}
                </p>
              </div>
              {r.active && (
                <button
                  className={btnSm}
                  disabled={lift.isPending}
                  onClick={() => lift.mutate(r.id)}
                >
                  Lift
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function ModerationLog() {
  const q = useQuery({ queryKey: ["admin", "modlog"], queryFn: adminApi.moderationLog });
  return (
    <Section title="Moderation history">
      {q.isPending ? (
        <Loading rows={2} />
      ) : q.isError ? (
        <ErrorState error={q.error} />
      ) : q.data.length === 0 ? (
        <EmptyRow>No chat moderation actions yet.</EmptyRow>
      ) : (
        <ul className="max-h-96 divide-y overflow-y-auto text-sm">
          {q.data.map((l) => (
            <li key={l.id} className="px-5 py-2.5">
              <span className="font-mono text-xs">{l.action}</span>{" "}
              <span className="text-muted-foreground">
                by @{l.moderator ?? "system"}
                {l.subject && ` · @${l.subject}`} · {fmtDate(l.createdAt)}
              </span>
              {l.reason && <p className="text-xs text-muted-foreground">{l.reason}</p>}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
