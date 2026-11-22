import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { AccountLayout, Empty, btnGhost, btn, metaFor } from "@/components/account/AccountLayout";
import { noticeTarget } from "@/components/layout/AppShell";
import { IS_API_MODE, markAllRead, useAuctionStore, type Notice } from "@/lib/auction-store";
import { useSession } from "@/lib/demo-session";
import { toNotice } from "@/lib/api/adapters";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/notifications")({
  head: () => ({ meta: metaFor("Notifications", "Outbid alerts, wins and auction updates.") }),
  component: () => (IS_API_MODE ? <ServerNotices /> : <DemoNotices />),
});

/** Server categories → notification types. */
const CATEGORIES: { key: string; label: string; types?: string[]; unread?: boolean }[] = [
  { key: "all", label: "All" },
  { key: "unread", label: "Unread", unread: true },
  { key: "bids", label: "Bids", types: ["OUTBID", "NEW_BID"] },
  {
    key: "auctions",
    label: "Auctions",
    types: [
      "AUCTION_STARTED",
      "AUCTION_ENDING_SOON",
      "AUCTION_REMINDER",
      "AUCTION_WON",
      "AUCTION_LOST",
      "AUCTION_SOLD",
      "AUCTION_UNSOLD",
      "AUCTION_APPROVED",
      "AUCTION_REJECTED",
      "ORDER_UPDATE",
    ],
  },
  { key: "chat", label: "Chat & messages", types: ["CHAT_MESSAGE", "DIRECT_MESSAGE"] },
  { key: "account", label: "Account", types: ["ACCOUNT_SECURITY"] },
  { key: "news", label: "Announcements", types: ["ANNOUNCEMENT", "SYSTEM"] },
];

const when = (at: number) =>
  new Date(at).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

function ServerNotices() {
  const user = useSession((s) => s.user);
  const restored = useSession((s) => s.restored);
  const live = useAuctionStore((s) => s.notices);
  const router = useRouter();
  const [cat, setCat] = useState("all");
  const [items, setItems] = useState<Notice[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(
    async (more: boolean) => {
      const c = CATEGORIES.find((x) => x.key === cat)!;
      setLoading(true);
      setError(false);
      try {
        const { loadNotificationPage } = await import("@/services/api");
        const page = await loadNotificationPage({
          ...(more && cursor ? { before: cursor } : {}),
          ...(c.types ? { types: c.types } : {}),
          ...(c.unread ? { unreadOnly: true } : {}),
        });
        const mapped = page.items.map(toNotice);
        setItems((prev) => (more ? [...prev, ...mapped] : mapped));
        setHasMore(page.hasMore);
        setCursor(page.items.at(-1)?.createdAt ?? null);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    },
    [cat, cursor],
  );

  useEffect(() => {
    if (user) void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cat, user?.id]);

  // Merge read-state changes and new real-time arrivals from the live store.
  useEffect(() => {
    setItems((prev) => {
      const byId = new Map(live.map((n) => [n.id, n]));
      const updated = prev.map((n) => (byId.has(n.id) ? { ...n, read: byId.get(n.id)!.read } : n));
      if (cat !== "all") return updated;
      const fresh = live.filter(
        (n) => !prev.some((p) => p.id === n.id) && n.at > (prev[0]?.at ?? 0),
      );
      return [...fresh, ...updated];
    });
  }, [live, cat]);

  if (!user)
    return (
      <AccountLayout title="Notifications">
        {restored ? (
          <Empty
            title="Sign in to see notifications"
            body="Outbid alerts, wins, chat activity and account alerts appear here."
            action={
              <Link to="/login" className={btn}>
                Sign in
              </Link>
            }
          />
        ) : (
          <div className="h-40 animate-pulse rounded-lg border bg-muted/40" />
        )}
      </AccountLayout>
    );

  const open = (n: Notice) => {
    void import("@/services/api").then((m) => m.markNoticeRead(n.id));
    setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
    const to = noticeTarget(n);
    if (to) void router.navigate({ to: to as "/" });
  };

  return (
    <AccountLayout
      title="Notifications"
      description="Your notification history. Manage email and in-app alerts in Settings."
      actions={
        <button
          onClick={() => {
            markAllRead();
            setItems((prev) => prev.map((n) => ({ ...n, read: true })));
          }}
          className={btnGhost}
        >
          Mark all read
        </button>
      }
    >
      <div className="mb-4 flex flex-wrap gap-1" role="tablist" aria-label="Filter notifications">
        {CATEGORIES.map((c) => (
          <button
            key={c.key}
            role="tab"
            aria-selected={cat === c.key}
            onClick={() => {
              setCursor(null);
              setCat(c.key);
            }}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm",
              cat === c.key ? "bg-accent" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {c.label}
          </button>
        ))}
      </div>
      {error ? (
        <Empty
          title="Couldn't load notifications"
          body="Check your connection and try again."
          action={
            <button className={btn} onClick={() => void load(false)}>
              Retry
            </button>
          }
        />
      ) : !loading && items.length === 0 ? (
        <Empty
          title="Nothing here yet"
          body="Alerts appear when you're outbid, an auction you follow starts or ends, someone chats in your room, or your account changes."
          action={
            <Link to="/live" className={btn}>
              Find a live auction
            </Link>
          }
        />
      ) : (
        <>
          <ul className="divide-y rounded-lg border bg-card">
            {items.map((n) => (
              <li key={n.id}>
                <button
                  onClick={() => open(n)}
                  className="flex w-full items-start gap-3 p-4 text-left hover:bg-accent"
                >
                  <span
                    className={cn(
                      "mt-1.5 size-2 shrink-0 rounded-full",
                      n.kind === "outbid" || n.kind === "lost" ? "bg-live" : "bg-success",
                      n.read && "opacity-30",
                    )}
                    aria-label={n.read ? "Read" : "Unread"}
                  />
                  <span className="min-w-0 flex-1 text-sm">
                    <span className={cn("block", !n.read && "font-medium")}>{n.text}</span>
                    {n.body && <span className="mt-0.5 block text-muted-foreground">{n.body}</span>}
                  </span>
                  <time className="shrink-0 text-xs text-muted-foreground tabular">
                    {when(n.at)}
                  </time>
                </button>
              </li>
            ))}
            {loading &&
              [0, 1, 2].map((i) => (
                <li key={`sk${i}`} className="p-4">
                  <div className="h-4 w-2/3 animate-pulse rounded bg-muted/60" />
                </li>
              ))}
          </ul>
          {hasMore && !loading && (
            <button onClick={() => void load(true)} className={cn(btnGhost, "mt-4 w-full")}>
              Load older notifications
            </button>
          )}
        </>
      )}
    </AccountLayout>
  );
}

const demoFilters = ["all", "unread", "outbid", "leading", "won", "lost"] as const;

function DemoNotices() {
  const notices = useAuctionStore((s) => s.notices);
  const [f, setF] = useState<(typeof demoFilters)[number]>("all");
  const rows = notices.filter((n) => f === "all" || (f === "unread" ? !n.read : n.kind === f));
  return (
    <AccountLayout
      title="Notifications"
      actions={
        <button onClick={markAllRead} className={btnGhost}>
          Mark all read
        </button>
      }
    >
      <div className="mb-4 flex flex-wrap gap-1">
        {demoFilters.map((x) => (
          <button
            key={x}
            onClick={() => setF(x)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm capitalize",
              f === x ? "bg-accent" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {x}
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <Empty
          title="No notifications"
          body="Alerts appear here when you're outbid, leading or an auction you bid on closes."
          action={
            <Link to="/live" className={btn}>
              Find a live auction
            </Link>
          }
        />
      ) : (
        <ul className="divide-y rounded-lg border bg-card">
          {rows.map((n) => (
            <li key={n.id}>
              <Link
                to="/room/$id"
                params={{ id: n.auctionId }}
                className="flex items-start gap-3 p-4 hover:bg-accent"
              >
                <span
                  className={cn(
                    "mt-1.5 size-2 shrink-0 rounded-full",
                    n.kind === "outbid" || n.kind === "lost" ? "bg-live" : "bg-success",
                    n.read && "opacity-30",
                  )}
                />
                <span className="min-w-0 flex-1 text-sm">{n.text}</span>
                <time className="shrink-0 text-xs text-muted-foreground tabular">
                  {new Date(n.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </time>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </AccountLayout>
  );
}
