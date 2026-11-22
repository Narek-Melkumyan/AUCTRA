import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { btn, input } from "@/components/account/AccountLayout";
import { adminApi, fmtDate, type AdminAccess } from "@/lib/api/admin";
import { cn } from "@/lib/utils";
import {
  EmptyRow,
  ErrorState,
  Loading,
  Pill,
  Section,
  btnSm,
  select,
  useAdminAction,
} from "./shared";

export function NotificationsPanel({ access }: { access: AdminAccess }) {
  return (
    <div className="space-y-6">
      <div className="grid gap-6 xl:grid-cols-2">
        <Composer />
        <History />
      </div>
      <Deliveries />
      {access.audit && <AuditLog />}
    </div>
  );
}

function Composer() {
  const [f, setF] = useState({ title: "", body: "", audience: "ALL", sendEmail: false, link: "" });
  const send = useAdminAction(
    () =>
      adminApi.announce({
        title: f.title.trim(),
        body: f.body.trim(),
        audience: f.audience,
        sendEmail: f.sendEmail,
        ...(f.link.trim() ? { link: f.link.trim() } : {}),
      }),
    {
      success: "Announcement sent",
      invalidate: [
        ["admin", "announcements"],
        ["admin", "deliveries"],
      ],
    },
  );
  const valid =
    f.title.trim().length >= 3 && f.body.trim().length >= 3 && (!f.link || f.link.startsWith("/"));
  return (
    <Section
      title="Send an announcement"
      description="Appears in every recipient's notification center in real time."
    >
      <form
        className="space-y-3 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          if (!confirm(`Send "${f.title}" to ${f.audience.toLowerCase()} users?`)) return;
          send.mutate(undefined, {
            onSuccess: () =>
              setF({ title: "", body: "", audience: "ALL", sendEmail: false, link: "" }),
          });
        }}
      >
        <label className="block text-sm">
          Title
          <input
            value={f.title}
            maxLength={200}
            onChange={(e) => setF({ ...f, title: e.target.value })}
            className={cn(input, "mt-1.5")}
          />
        </label>
        <label className="block text-sm">
          Message
          <textarea
            value={f.body}
            maxLength={2000}
            rows={4}
            onChange={(e) => setF({ ...f, body: e.target.value })}
            className={cn(input, "mt-1.5 h-auto py-2")}
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            Audience
            <select
              value={f.audience}
              onChange={(e) => setF({ ...f, audience: e.target.value })}
              className={cn(select, "mt-1.5 w-full")}
            >
              <option value="ALL">Everyone</option>
              <option value="BIDDERS">Bidders</option>
              <option value="SELLERS">Sellers</option>
              <option value="STAFF">Staff</option>
            </select>
          </label>
          <label className="block text-sm">
            Link (optional, in-app path)
            <input
              value={f.link}
              placeholder="/live"
              onChange={(e) => setF({ ...f, link: e.target.value })}
              className={cn(input, "mt-1.5")}
            />
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={f.sendEmail}
            onChange={(e) => setF({ ...f, sendEmail: e.target.checked })}
          />
          Also email recipients who allow announcement emails (via Resend)
        </label>
        <button className={btn} disabled={!valid || send.isPending}>
          {send.isPending ? "Sending…" : "Send announcement"}
        </button>
      </form>
    </Section>
  );
}

function History() {
  const q = useQuery({ queryKey: ["admin", "announcements"], queryFn: adminApi.announcements });
  return (
    <Section title="Announcement history">
      {q.isPending ? (
        <Loading rows={3} />
      ) : q.isError ? (
        <ErrorState error={q.error} />
      ) : q.data.length === 0 ? (
        <EmptyRow>No announcements yet.</EmptyRow>
      ) : (
        <ul className="max-h-[440px] divide-y overflow-y-auto text-sm">
          {q.data.map((a) => (
            <li key={a.id} className="px-5 py-3">
              <p className="font-medium">{a.title}</p>
              <p className="text-xs text-muted-foreground">
                {fmtDate(a.createdAt)} · {a.audience.toLowerCase()} · {a.recipientCount} recipients
                · {a.read} read
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {a.deliveries.map((d) => (
                  <span
                    key={`${d.channel}${d.status}`}
                    className="rounded border px-1.5 py-0.5 text-[11px]"
                  >
                    {d.channel.toLowerCase().replace("_", "-")} {d.status.toLowerCase()}: {d.count}
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Deliveries() {
  const [status, setStatus] = useState("FAILED");
  const q = useQuery({
    queryKey: ["admin", "deliveries", status],
    queryFn: () => adminApi.deliveries({ channel: "EMAIL", ...(status ? { status } : {}) }),
    refetchInterval: 20_000,
  });
  const retry = useAdminAction((id: string) => adminApi.retryDelivery(id), {
    success: "Queued for another attempt",
    invalidate: [["admin", "deliveries"]],
  });
  return (
    <Section
      title="Email delivery status"
      description="Emails are only marked sent when Resend accepts them. Skipped = no provider, unverified address, already read, or spam limits."
      actions={
        <select
          aria-label="Delivery status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className={select}
        >
          <option value="">All</option>
          {["FAILED", "PENDING", "SENT", "SKIPPED"].map((s) => (
            <option key={s} value={s}>
              {s.toLowerCase()}
            </option>
          ))}
        </select>
      }
    >
      {q.isPending ? (
        <Loading rows={3} />
      ) : q.isError ? (
        <ErrorState error={q.error} />
      ) : (
        <>
          <div className="flex flex-wrap gap-2 border-b px-5 py-3">
            {q.data.summary
              .filter((s) => s.channel === "EMAIL")
              .map((s) => (
                <span key={s.status} className="flex items-center gap-1.5 text-xs">
                  <Pill value={s.status} /> {s.count}
                </span>
              ))}
          </div>
          {q.data.items.length === 0 ? (
            <EmptyRow>No {status ? status.toLowerCase() : ""} email deliveries.</EmptyRow>
          ) : (
            <ul className="max-h-[420px] divide-y overflow-y-auto text-sm">
              {q.data.items.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                  <Pill value={d.status} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate">{d.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {d.recipient} · {d.type.toLowerCase().replace(/_/g, " ")} · {d.attempts}{" "}
                      attempt(s) · {fmtDate(d.updatedAt)}
                      {d.lastError && ` · ${d.lastError}`}
                    </p>
                  </div>
                  {(d.status === "FAILED" || d.status === "SKIPPED") && (
                    <button
                      className={btnSm}
                      disabled={retry.isPending}
                      onClick={() => retry.mutate(d.id)}
                    >
                      Retry
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Section>
  );
}

function AuditLog() {
  const [action, setAction] = useState("");
  const q = useQuery({
    queryKey: ["admin", "audit", action],
    queryFn: () => adminApi.audit(action || undefined),
  });
  return (
    <Section
      title="Audit log"
      description="Security and administrative actions, newest first."
      actions={
        <input
          value={action}
          onChange={(e) => setAction(e.target.value)}
          placeholder="Exact action, e.g. user.banned"
          aria-label="Filter audit log"
          className={cn(input, "h-9 w-56")}
        />
      }
    >
      {q.isPending ? (
        <Loading rows={3} />
      ) : q.isError ? (
        <ErrorState error={q.error} />
      ) : q.data.length === 0 ? (
        <EmptyRow>No entries.</EmptyRow>
      ) : (
        <ul className="max-h-[420px] divide-y overflow-y-auto text-xs">
          {q.data.map((a) => (
            <li key={a.id} className="flex flex-wrap justify-between gap-3 px-5 py-2.5">
              <span className="font-mono">{a.action}</span>
              <span className="text-muted-foreground">
                {a.entityType && `${a.entityType} ${a.entityId?.slice(0, 8)} · `}
                {fmtDate(a.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
