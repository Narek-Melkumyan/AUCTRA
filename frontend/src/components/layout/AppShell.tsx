import { useEffect, useState } from "react";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import {
  Bell,
  Compass,
  Gavel,
  Heart,
  Home,
  LayoutGrid,
  Menu,
  MessageSquare,
  Moon,
  ShieldCheck,
  Radio,
  Search,
  Sparkles,
  Sun,
  Tag,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useNavCategories } from "@/lib/api/categories";
import { CategoryThumb } from "@/components/explore/CategoryThumb";
import { IS_API_MODE, markAllRead, useAuctionStore, type Notice } from "@/lib/auction-store";
import { onSocketEvent } from "@/lib/api/live";
import { AiChat } from "@/components/ai/AiChat";
import { AssistantChat } from "@/components/ai/AssistantChat";
import { useSession } from "@/lib/demo-session";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { canOpenAdmin } from "@/lib/api/admin";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { toRoom } from "@/lib/api/adapters";
import type { AuctionDto } from "@/lib/api/types";
import { useUnreadMessages } from "@/lib/api/messages";
import { refreshMe } from "@/lib/api/account";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { AuctionImage } from "@/components/auction/AuctionImage";
import { photoOf } from "@/lib/media";

export function Logo() {
  return (
    <Link to="/" className="flex items-center gap-2" aria-label="AUCTRA home">
      <span className="grid size-8 place-items-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">
        A
      </span>
      <span className="text-[15px] font-semibold tracking-[0.14em]">AUCTRA</span>
    </Link>
  );
}

function useTheme() {
  const [light, setLight] = useState(false);
  useEffect(() => {
    const v = localStorage.getItem("auctra-theme") === "light";
    setLight(v);
    document.documentElement.classList.toggle("light", v);
  }, []);
  const toggle = () => {
    const v = !light;
    setLight(v);
    localStorage.setItem("auctra-theme", v ? "light" : "dark");
    document.documentElement.classList.toggle("light", v);
  };
  return { light, toggle };
}

const nav = [
  { to: "/explore", label: "Explore" },
  { to: "/live", label: "Live Now" },
  { to: "/sell", label: "Sell an Item" },
  { to: "/how-it-works", label: "How It Works" },
] as const;

const noticeTime = (at: number) => {
  const mins = Math.round((Date.now() - at) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h}h` : new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
};

/** Where a notice leads: the server-provided path (API mode) or the auction room. */
export function noticeTarget(n: Notice): string | null {
  if (n.link) return n.link;
  return n.auctionId ? `/room/${n.auctionId}` : null;
}

function Notifications() {
  const notices = useAuctionStore((s) => s.notices);
  const serverUnread = useAuctionStore((s) => s.noticeUnread);
  const unread = serverUnread ?? notices.filter((n) => !n.read).length;
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const openNotice = (n: Notice) => {
    setOpen(false);
    if (IS_API_MODE) void import("@/services/api").then((m) => m.markNoticeRead(n.id));
    const to = noticeTarget(n);
    if (to) void router.navigate({ to: to as "/" });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        className="relative grid size-10 place-items-center rounded-full hover:bg-accent"
      >
        <Bell className="size-5" />
        {unread > 0 && (
          <span className="absolute right-1.5 top-1.5 grid min-w-4 place-items-center rounded-full bg-live px-1 text-[10px] font-semibold text-live-foreground">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[22rem] p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <p className="font-semibold">Notifications</p>
          <div className="flex gap-3">
            <button
              onClick={markAllRead}
              disabled={unread === 0}
              className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
            >
              Mark all read
            </button>
            <Link
              to="/notifications"
              onClick={() => setOpen(false)}
              className="text-xs font-medium"
            >
              View all
            </Link>
          </div>
        </div>
        <div className="max-h-96 overflow-y-auto">
          {notices.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              {IS_API_MODE
                ? "You're all caught up. Bids, wins, chat activity and account alerts show up here."
                : "No notifications yet. Place a demo bid to see outbid and winning alerts."}
            </p>
          ) : (
            notices.slice(0, 20).map((n) => (
              <button
                key={n.id}
                onClick={() => openNotice(n)}
                className={cn(
                  "flex w-full gap-3 border-b px-4 py-3 text-left text-sm hover:bg-accent",
                  !n.read && "bg-primary/5",
                )}
              >
                <span
                  className={cn(
                    "mt-1.5 size-2 shrink-0 rounded-full",
                    n.kind === "outbid" || n.kind === "lost" ? "bg-live" : "bg-success",
                    n.read && "opacity-30",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className={cn("block", !n.read && "font-medium")}>{n.text}</span>
                  {n.body && (
                    <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
                      {n.body}
                    </span>
                  )}
                </span>
                <time className="shrink-0 text-[11px] text-muted-foreground tabular">
                  {noticeTime(n.at)}
                </time>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** API mode: toast new real-time notifications with a shortcut to what they're about. */
function LiveNoticeToasts() {
  const router = useRouter();
  useEffect(() => {
    if (!IS_API_MODE) return;
    return onSocketEvent("notification", (p) => {
      const n = p as { id: string; title: string; body: string; link: string | null; type: string };
      if (n.type === "NEW_BID" || n.type === "CHAT_MESSAGE") return; // badge only, no toast
      toast(n.title, {
        description: n.body,
        ...(n.link
          ? {
              action: {
                label: "Open",
                onClick: () => {
                  void import("@/services/api").then((m) => m.markNoticeRead(n.id));
                  void router.navigate({ to: n.link as "/" });
                },
              },
            }
          : {}),
      });
    });
  }, [router]);
  return null;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { light, toggle } = useTheme();
  const [scrolled, setScrolled] = useState(false);
  const [menu, setMenu] = useState(false);
  const [ai, setAi] = useState(false);
  const [search, setSearch] = useState(false);
  const watchCount = useAuctionStore((s) => s.watchlist.length);
  const navCats = useNavCategories();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const inRoom = path.startsWith("/room/");

  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 12);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  useEffect(() => setMenu(false), [path]);
  // Roles can change while the tab is open (e.g. a grant by another admin): re-read them
  // when the user returns to the tab, at most once a minute, so staff links stay accurate.
  useEffect(() => {
    if (!IS_API_MODE) return;
    let last = 0;
    const onFocus = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < 60_000) return;
      last = Date.now();
      void refreshMe();
    };
    document.addEventListener("visibilitychange", onFocus);
    return () => document.removeEventListener("visibilitychange", onFocus);
  }, []);

  return (
    <div className="min-h-screen">
      <header
        className={cn(
          "sticky top-0 z-40 transition-all duration-300",
          scrolled ? "border-b bg-background/95 backdrop-blur" : "border-b bg-background",
        )}
      >
        <div className="mx-auto flex h-16 max-w-[1440px] items-center gap-4 px-4 sm:px-6 lg:px-10">
          <button
            className="grid size-10 place-items-center rounded-full hover:bg-accent lg:hidden"
            aria-label="Open menu"
            onClick={() => setMenu(true)}
          >
            <Menu className="size-5" />
          </button>
          <Logo />
          <nav className="ml-6 hidden items-center gap-1 lg:flex">
            <div className="group relative">
              <button className="rounded-full px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground">
                Categories
              </button>
              <div className="invisible absolute left-0 top-full w-[560px] translate-y-2 rounded-2xl border bg-popover p-4 opacity-0 shadow-card transition group-hover:visible group-hover:translate-y-0 group-hover:opacity-100">
                <div className="grid grid-cols-2 gap-2">
                  {navCats.map((c) => (
                    <Link
                      key={c.key}
                      to="/explore"
                      search={{ category: c.param }}
                      className="flex items-center gap-3 rounded-xl p-2 hover:bg-accent"
                    >
                      <CategoryThumb name={c.name} image={c.image} className="size-12 rounded-lg" />
                      <div>
                        <p className="text-sm font-semibold">{c.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {c.count.toLocaleString()} {IS_API_MODE ? "open lots" : "lots"}
                        </p>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            </div>
            {nav.map((n) => (
              <Link
                key={n.to}
                to={n.to}
                className="rounded-full px-3 py-2 text-sm font-medium text-muted-foreground transition hover:text-foreground"
                activeProps={{ className: "text-foreground" }}
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={() => setSearch(true)}
              className="hidden h-10 items-center gap-2 rounded-full border px-4 text-sm text-muted-foreground hover:text-foreground md:flex"
            >
              <Search className="size-4" /> Search auctions
            </button>
            <button
              onClick={() => setSearch(true)}
              aria-label="Search"
              className="grid size-10 place-items-center rounded-full hover:bg-accent md:hidden"
            >
              <Search className="size-5" />
            </button>
            <button
              onClick={() => setAi(true)}
              aria-label="AUCTRA AI"
              className="hidden size-10 place-items-center rounded-full hover:bg-accent sm:grid"
            >
              <Sparkles className="size-5 text-primary" />
            </button>
            <AdminLink />
            <MessagesLink />
            <Notifications />
            <Link
              to="/watchlist"
              aria-label="Watchlist"
              className="relative hidden size-10 place-items-center rounded-full hover:bg-accent sm:grid"
            >
              <Heart className="size-5" />
              {watchCount > 0 && (
                <span className="absolute right-1 top-1 text-[10px] font-semibold text-primary">
                  {watchCount}
                </span>
              )}
            </Link>
            <button
              onClick={toggle}
              aria-label="Toggle theme"
              className="grid size-10 place-items-center rounded-full hover:bg-accent"
            >
              {light ? <Moon className="size-5" /> : <Sun className="size-5" />}
            </button>
            <AccountButton />
          </div>
        </div>
      </header>
      <VerifyBanner />
      <LiveNoticeToasts />

      <main className={cn(inRoom ? "pb-0" : "pb-20 lg:pb-0")}>{children}</main>

      {!inRoom && <Footer />}

      {/* Mobile bottom nav */}
      {!inRoom && (
        <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t glass pb-[env(safe-area-inset-bottom)] lg:hidden">
          {[
            { to: "/", icon: Home, label: "Home" },
            { to: "/explore", icon: Compass, label: "Explore" },
            { to: "/live", icon: Radio, label: "Live" },
            { to: "/sell", icon: Tag, label: "Sell" },
          ].map((i) => (
            <Link
              key={i.to}
              to={i.to}
              activeOptions={{ exact: i.to === "/" }}
              className="flex flex-col items-center gap-1 py-2.5 text-[11px] text-muted-foreground"
              activeProps={{ className: "text-primary" }}
            >
              <i.icon className="size-5" />
              {i.label}
            </Link>
          ))}
          <button
            onClick={() => setAi(true)}
            className="flex flex-col items-center gap-1 py-2.5 text-[11px] text-muted-foreground"
          >
            <Sparkles className="size-5" />
            AI
          </button>
        </nav>
      )}

      {/* Floating AI button (desktop) */}
      {!ai && !inRoom && (
        <button
          onClick={() => setAi(true)}
          className="fixed bottom-6 right-6 z-40 hidden items-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-pop transition lg:flex"
        >
          <Sparkles className="size-4" /> Ask AUCTRA AI
        </button>
      )}
      {ai && (
        <div className="fixed inset-0 z-50 flex flex-col bg-popover sm:inset-auto sm:bottom-6 sm:right-6 sm:h-[600px] sm:w-[400px] sm:overflow-hidden sm:rounded-2xl sm:border sm:shadow-card animate-in fade-in slide-in-from-bottom-4">
          <div className="flex items-center gap-3 border-b px-4 py-3">
            <div className="grid size-8 place-items-center rounded-md border text-muted-foreground">
              <Sparkles className="size-4" />
            </div>
            <div className="flex-1">
              <p className="font-semibold">AUCTRA AI</p>
              <p className="text-xs text-success">
                {IS_API_MODE ? "Online · answers from live AUCTRA data" : "Online · demo responses"}
              </p>
            </div>
            <button
              onClick={() => setAi(false)}
              aria-label="Close assistant"
              className="grid size-9 place-items-center rounded-full hover:bg-accent"
            >
              <X className="size-5" />
            </button>
          </div>
          {IS_API_MODE ? <AssistantChat compact /> : <AiChat />}
        </div>
      )}

      <Sheet open={menu} onOpenChange={setMenu}>
        <SheetContent side="left" className="w-[85vw] max-w-sm">
          <SheetTitle className="sr-only">Menu</SheetTitle>
          <div className="mb-6">
            <Logo />
          </div>
          <div className="space-y-1">
            {nav.map((n) => (
              <Link
                key={n.to}
                to={n.to}
                className="block rounded-xl px-3 py-3 text-base font-medium hover:bg-accent"
              >
                {n.label}
              </Link>
            ))}
          </div>
          <SheetStaffLink />
          <p className="mb-2 mt-6 px-3 text-xs text-muted-foreground">Account</p>
          <div className="space-y-1">
            {IS_API_MODE &&
              (
                [
                  ["/messages", "Messages"],
                  ["/favorites", "Favourites"],
                  ["/addresses", "Address book"],
                ] as const
              ).map(([to, l]) => (
                <Link
                  key={to}
                  to={to}
                  className="block rounded-md px-3 py-2 text-sm hover:bg-accent"
                >
                  {l}
                </Link>
              ))}
            {(
              [
                ["/dashboard", "Dashboard"],
                ["/bids", "My bids"],
                ["/watchlist", "Watchlist"],
                ["/orders", "Orders"],
                ["/notifications", "Notifications"],
                ["/settings", "Settings"],
                ["/help", "Help"],
              ] as const
            ).map(([to, l]) => (
              <Link key={to} to={to} className="block rounded-md px-3 py-2 text-sm hover:bg-accent">
                {l}
              </Link>
            ))}
          </div>
          <p className="mb-2 mt-6 px-3 text-xs text-muted-foreground">Categories</p>
          <div className="grid grid-cols-2 gap-2">
            {navCats.map((c) => (
              <Link
                key={c.key}
                to="/explore"
                search={{ category: c.param }}
                className="rounded-xl border px-3 py-2.5 text-sm hover:border-primary/50"
              >
                {c.name}
              </Link>
            ))}
          </div>
        </SheetContent>
      </Sheet>

      {search && <SearchOverlay onClose={() => setSearch(false)} />}
    </div>
  );
}

function SearchOverlay({ onClose }: { onClose: () => void }) {
  const rooms = useAuctionStore((s) => s.rooms);
  const navCats = useNavCategories();
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  // API mode searches the whole catalogue on the server; demo mode filters local lots.
  const server = useQuery({
    queryKey: ["search", dq],
    queryFn: () =>
      api<{ items: AuctionDto[]; total: number }>(
        `/auctions?phase=all&limit=8&q=${encodeURIComponent(dq)}`,
      ),
    enabled: IS_API_MODE && dq.length > 0,
  });
  const results = !q.trim()
    ? []
    : IS_API_MODE
      ? (server.data?.items ?? []).map((a) => rooms[a.id] ?? toRoom(a, null))
      : Object.values(rooms).filter((r) =>
          `${r.title} ${r.category} ${r.location}`.toLowerCase().includes(q.toLowerCase()),
        );
  const pending = IS_API_MODE && q.trim() && (dq !== q.trim() || server.isPending);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 bg-background/80 backdrop-blur-md animate-in fade-in"
      onClick={onClose}
    >
      <div
        className="mx-auto mt-0 max-w-2xl bg-popover sm:mt-24 sm:rounded-2xl sm:border sm:shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b px-4">
          <Search className="size-5 text-muted-foreground" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search cars, watches, art, homes…"
            className="h-16 flex-1 bg-transparent text-lg outline-none"
          />
          <button
            onClick={onClose}
            aria-label="Close search"
            className="grid size-9 place-items-center rounded-full hover:bg-accent"
          >
            <X className="size-5" />
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-2">
          {!q && (
            <div className="flex flex-wrap gap-2 p-3">
              {navCats.map((c) => (
                <Link
                  key={c.key}
                  to="/explore"
                  search={{ category: c.param }}
                  onClick={onClose}
                  className="rounded-full border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
                >
                  <LayoutGrid className="mr-1 inline size-3.5" />
                  {c.name}
                </Link>
              ))}
            </div>
          )}
          {q && !pending && results.length === 0 && (
            <p className="p-8 text-center text-muted-foreground">No lots match "{q}".</p>
          )}
          {pending && results.length === 0 && (
            <p className="p-8 text-center text-muted-foreground">Searching…</p>
          )}
          {results.map((r) => (
            <Link
              key={r.id}
              to="/item/$id"
              params={{ id: r.id }}
              onClick={onClose}
              className="flex items-center gap-3 rounded-xl p-2 hover:bg-accent"
            >
              <AuctionImage
                photo={photoOf(r)}
                size="thumb"
                sizes="56px"
                alt=""
                className="size-14 rounded-lg object-cover"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{r.title}</p>
                <p className="text-sm text-muted-foreground">
                  {r.category} · {r.location}
                </p>
              </div>
              <Gavel className="size-4 text-muted-foreground" />
            </Link>
          ))}
          {IS_API_MODE && (server.data?.total ?? 0) > results.length && (
            <Link
              to="/explore"
              search={{ q: dq }}
              onClick={onClose}
              className="block rounded-xl p-3 text-center text-sm font-medium hover:bg-accent"
            >
              See all {server.data!.total.toLocaleString()} results
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

function Footer() {
  return (
    <footer className="mt-24 border-t bg-surface">
      <div className="mx-auto grid max-w-[1440px] gap-10 px-4 py-16 sm:px-6 md:grid-cols-2 lg:grid-cols-6 lg:px-10">
        <div className="lg:col-span-2">
          <Logo />
          <p className="mt-4 max-w-xs text-sm text-muted-foreground">
            The modern auction house for extraordinary things — from grand tourers to fine jewelry.
          </p>
          {IS_API_MODE ? (
            <p className="mt-6 max-w-sm text-sm text-muted-foreground">
              Get outbid, ending-soon and result alerts by email —{" "}
              <Link to="/settings" className="text-foreground underline-offset-4 hover:underline">
                choose your notifications
              </Link>
              .
            </p>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                toast.success("Thanks — newsletter signup is a demo.");
              }}
              className="mt-6 flex max-w-sm gap-2"
            >
              <input
                type="email"
                required
                placeholder="Email address"
                className="h-11 min-w-0 flex-1 rounded-xl border bg-background px-3 text-sm outline-none focus:border-primary"
              />
              <button className="h-11 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground">
                Subscribe
              </button>
            </form>
          )}
        </div>
        {(
          [
            {
              h: "Marketplace",
              l: [
                ["Explore", "/explore"],
                ["Live Now", "/live"],
                ["Sell an Item", "/sell"],
              ],
            },
            {
              h: "Account",
              l: [
                ["Dashboard", "/dashboard"],
                ["My bids", "/bids"],
                ["Watchlist", "/watchlist"],
                ["Orders", "/orders"],
              ],
            },
            {
              h: "Help",
              l: [
                ["Help Center", "/help"],
                ["Assistant", "/assistant"],
                ["How It Works", "/how-it-works"],
              ],
            },
            {
              h: "More",
              l: [
                ["How It Works", "/how-it-works"],
                ["Help Center", "/help"],
              ],
            },
          ] as const
        ).map((c) => (
          <div key={c.h}>
            <p className="mb-4 text-sm font-semibold">{c.h}</p>
            <ul className="space-y-2.5 text-sm text-muted-foreground">
              {c.l.map(([t, h]) => (
                <li key={t}>
                  <Link to={h} className="hover:text-foreground">
                    {t}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t px-4 py-6 text-center text-xs text-muted-foreground">
        © 2026 AUCTRA. Demo interface — figures and listings are illustrative.
      </div>
    </footer>
  );
}

/** Shown to signed-in users whose email is not verified yet (API mode). */
function VerifyBanner() {
  const user = useSession((s) => s.user);
  const path = useRouterState({ select: (s) => s.location.pathname });
  if (!user || user.emailVerified !== false || path === "/verify-email") return null;
  return (
    <div className="border-b bg-primary/5">
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm sm:px-6 lg:px-10">
        <span className="text-muted-foreground">
          Verify your email address to place bids and chat in auction rooms.
        </span>
        <Link
          to="/verify-email"
          search={{ token: "", delivery: "" }}
          className="font-medium underline-offset-4 hover:underline"
        >
          Enter code
        </Link>
      </div>
    </div>
  );
}

function AccountButton() {
  const user = useSession((s) => s.user);
  if (!user)
    return (
      <Link
        to="/login"
        className="ml-2 hidden h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground sm:inline-flex"
      >
        Sign in
      </Link>
    );
  return (
    <Link
      to="/dashboard"
      aria-label="Your account"
      className="ml-2 hidden size-9 place-items-center rounded-md border text-sm font-medium uppercase sm:grid"
    >
      {user.name.slice(0, 1)}
    </Link>
  );
}

/** Staff-only entry to the operations dashboard (permissions come from the server). */
function AdminLink() {
  const user = useSession((s) => s.user);
  if (!IS_API_MODE || !canOpenAdmin(user)) return null;
  return (
    <Link
      to="/admin"
      aria-label="Admin dashboard"
      className="mr-1 hidden h-9 items-center gap-1.5 rounded-md border border-primary/30 px-3 text-sm font-medium text-foreground transition hover:bg-accent sm:inline-flex"
      activeProps={{ className: "bg-accent" }}
    >
      <ShieldCheck className="size-4 text-primary" />
      <span className="hidden xl:inline">Admin</span>
    </Link>
  );
}

function SheetStaffLink() {
  const user = useSession((s) => s.user);
  if (!IS_API_MODE || !canOpenAdmin(user)) return null;
  return (
    <Link
      to="/admin"
      className="mt-6 flex items-center gap-2 rounded-xl border border-primary/30 px-3 py-3 text-base font-medium hover:bg-accent"
    >
      <ShieldCheck className="size-5 text-primary" /> Admin dashboard
    </Link>
  );
}

/** Buyer–seller inbox with a live unread badge (API mode, signed in). */
function MessagesLink() {
  const user = useSession((s) => s.user);
  const unread = useUnreadMessages();
  if (!IS_API_MODE || !user) return null;
  return (
    <Link
      to="/messages"
      aria-label={unread ? `Messages, ${unread} unread` : "Messages"}
      className="relative grid size-10 place-items-center rounded-full hover:bg-accent"
    >
      <MessageSquare className="size-5" />
      {unread > 0 && (
        <span className="absolute right-1 top-1 grid min-w-4 place-items-center rounded-full bg-live px-1 text-[10px] font-semibold text-white">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </Link>
  );
}
