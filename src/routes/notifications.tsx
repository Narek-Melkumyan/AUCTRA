import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AccountLayout, Empty, btnGhost, btn, metaFor } from "@/components/account/AccountLayout";
import { markAllRead, useAuctionStore } from "@/lib/auction-store";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/notifications")({
  head: () => ({ meta: metaFor("Notifications", "Outbid alerts, wins and auction updates.") }),
  component: Notices,
});

const filters = ["all", "unread", "outbid", "leading", "won", "lost"] as const;

function Notices() {
  const notices = useAuctionStore((s) => s.notices);
  const [f, setF] = useState<(typeof filters)[number]>("all");
  const rows = notices.filter((n) => f === "all" || (f === "unread" ? !n.read : n.kind === f));
  return (
    <AccountLayout title="Notifications" actions={<button onClick={markAllRead} className={btnGhost}>Mark all read</button>}>
      <div className="mb-4 flex flex-wrap gap-1">
        {filters.map((x) => <button key={x} onClick={() => setF(x)} className={cn("rounded-md px-3 py-1.5 text-sm capitalize", f === x ? "bg-accent" : "text-muted-foreground hover:text-foreground")}>{x}</button>)}
      </div>
      {rows.length === 0 ? (
        <Empty title="No notifications" body="Alerts appear here when you're outbid, leading or an auction you bid on closes." action={<Link to="/live" className={btn}>Find a live auction</Link>} />
      ) : (
        <ul className="divide-y rounded-lg border bg-card">
          {rows.map((n) => (
            <li key={n.id}>
              <Link to="/room/$id" params={{ id: n.auctionId }} className="flex items-start gap-3 p-4 hover:bg-accent">
                <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", n.kind === "outbid" || n.kind === "lost" ? "bg-live" : "bg-success", n.read && "opacity-30")} />
                <span className="min-w-0 flex-1 text-sm">{n.text}</span>
                <time className="shrink-0 text-xs text-muted-foreground tabular">{new Date(n.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </AccountLayout>
  );
}
