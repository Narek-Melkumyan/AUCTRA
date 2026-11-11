import { useEffect, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { Bell, Compass, Gavel, Heart, Home, LayoutGrid, Menu, Moon, Radio, RotateCcw, Search, Sparkles, Sun, Tag, X } from "lucide-react";
import { toast } from "sonner";
import { categories } from "@/lib/auctions";
import { markAllRead, resetDemo, useAuctionStore } from "@/lib/auction-store";
import { AiChat } from "@/components/ai/AiChat";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export function Logo() {
  return (
    <Link to="/" className="flex items-center gap-2" aria-label="AUCTRA home">
      <span className="grid size-8 place-items-center rounded-lg bg-gold-gradient font-display text-xl text-primary-foreground">A</span>
      <span className="text-lg font-semibold tracking-[0.18em]">AUCTRA</span>
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
  { to: "/admin", label: "Admin" },
] as const;

function Notifications() {
  const notices = useAuctionStore((s) => s.notices);
  const unread = notices.filter((n) => !n.read).length;
  return (
    <Popover onOpenChange={(o) => !o && markAllRead()}>
      <PopoverTrigger aria-label="Notifications" className="relative grid size-10 place-items-center rounded-full hover:bg-accent">
        <Bell className="size-5" />
        {unread > 0 && <span className="absolute right-1.5 top-1.5 grid min-w-4 place-items-center rounded-full bg-live px-1 text-[10px] font-semibold text-live-foreground">{unread}</span>}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <p className="font-semibold">Notifications</p>
          <button onClick={markAllRead} className="text-xs text-primary">Mark all read</button>
        </div>
        <div className="max-h-80 overflow-y-auto">
          {notices.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">No notifications yet. Place a demo bid to see outbid and winning alerts.</p>
          ) : (
            notices.map((n) => (
              <Link key={n.id} to="/room/$id" params={{ id: n.auctionId }} className={cn("flex gap-3 border-b px-4 py-3 text-sm hover:bg-accent", !n.read && "bg-primary/5")}>
                <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", n.kind === "outbid" || n.kind === "lost" ? "bg-live" : "bg-success")} />
                <span>{n.text}</span>
              </Link>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { light, toggle } = useTheme();
  const [scrolled, setScrolled] = useState(false);
  const [menu, setMenu] = useState(false);
  const [ai, setAi] = useState(false);
  const [search, setSearch] = useState(false);
  const watchCount = useAuctionStore((s) => s.watchlist.length);
  const path = useRouterState({ select: (s) => s.location.pathname });
  const inRoom = path.startsWith("/room/");

  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 12);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  useEffect(() => setMenu(false), [path]);

  return (
    <div className="min-h-screen">
      <div className="flex items-center justify-center gap-3 bg-primary/10 px-4 py-1.5 text-xs text-foreground">
        <span className="font-semibold uppercase tracking-wider text-primary">Demo mode</span>
        <span className="hidden text-muted-foreground sm:inline">Bids, timers and activity are simulated locally — not real auction data.</span>
        <button onClick={() => { resetDemo(); toast.success("Demo reset"); }} className="inline-flex items-center gap-1 font-semibold text-primary hover:underline">
          <RotateCcw className="size-3" /> Reset demo
        </button>
      </div>
      <header className={cn("sticky top-0 z-40 transition-all duration-300", scrolled ? "glass border-b" : "bg-transparent")}>
        <div className="mx-auto flex h-16 max-w-[1440px] items-center gap-4 px-4 sm:px-6 lg:px-10">
          <button className="grid size-10 place-items-center rounded-full hover:bg-accent lg:hidden" aria-label="Open menu" onClick={() => setMenu(true)}><Menu className="size-5" /></button>
          <Logo />
          <nav className="ml-6 hidden items-center gap-1 lg:flex">
            <div className="group relative">
              <button className="rounded-full px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground">Categories</button>
              <div className="invisible absolute left-0 top-full w-[560px] translate-y-2 rounded-2xl border bg-popover p-4 opacity-0 shadow-card transition group-hover:visible group-hover:translate-y-0 group-hover:opacity-100">
                <div className="grid grid-cols-2 gap-2">
                  {categories.map((c) => (
                    <Link key={c.slug} to="/explore" search={{ category: c.name }} className="flex items-center gap-3 rounded-xl p-2 hover:bg-accent">
                      <img src={c.image} alt="" className="size-12 rounded-lg object-cover" />
                      <div><p className="text-sm font-semibold">{c.name}</p><p className="text-xs text-muted-foreground">{c.count.toLocaleString()} lots</p></div>
                    </Link>
                  ))}
                </div>
              </div>
            </div>
            {nav.map((n) => (
              <Link key={n.to} to={n.to} className="rounded-full px-3 py-2 text-sm font-medium text-muted-foreground transition hover:text-foreground" activeProps={{ className: "text-foreground" }}>
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <button onClick={() => setSearch(true)} className="hidden h-10 items-center gap-2 rounded-full border px-4 text-sm text-muted-foreground hover:text-foreground md:flex"><Search className="size-4" /> Search auctions</button>
            <button onClick={() => setSearch(true)} aria-label="Search" className="grid size-10 place-items-center rounded-full hover:bg-accent md:hidden"><Search className="size-5" /></button>
            <button onClick={() => setAi(true)} aria-label="AUCTRA AI" className="hidden size-10 place-items-center rounded-full hover:bg-accent sm:grid"><Sparkles className="size-5 text-primary" /></button>
            <Notifications />
            <Link to="/explore" search={{ watchlist: true }} aria-label="Watchlist" className="relative hidden size-10 place-items-center rounded-full hover:bg-accent sm:grid">
              <Heart className="size-5" />
              {watchCount > 0 && <span className="absolute right-1 top-1 text-[10px] font-semibold text-primary">{watchCount}</span>}
            </Link>
            <button onClick={toggle} aria-label="Toggle theme" className="grid size-10 place-items-center rounded-full hover:bg-accent">{light ? <Moon className="size-5" /> : <Sun className="size-5" />}</button>
            <button onClick={() => toast("Accounts arrive once a backend is connected.", { description: "This demo runs without sign-in." })} className="ml-2 hidden h-10 rounded-full bg-foreground px-5 text-sm font-semibold text-background sm:block">Sign in</button>
          </div>
        </div>
      </header>

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
            <Link key={i.to} to={i.to} activeOptions={{ exact: i.to === "/" }} className="flex flex-col items-center gap-1 py-2.5 text-[11px] text-muted-foreground" activeProps={{ className: "text-primary" }}>
              <i.icon className="size-5" />{i.label}
            </Link>
          ))}
          <button onClick={() => setAi(true)} className="flex flex-col items-center gap-1 py-2.5 text-[11px] text-muted-foreground"><Sparkles className="size-5" />AI</button>
        </nav>
      )}

      {/* Floating AI button (desktop) */}
      {!ai && !inRoom && (
        <button onClick={() => setAi(true)} className="fixed bottom-6 right-6 z-40 hidden items-center gap-2 rounded-full bg-gold-gradient px-5 py-3.5 text-sm font-semibold text-primary-foreground shadow-gold transition lg:flex">
          <Sparkles className="size-4" /> Ask AUCTRA AI
        </button>
      )}
      {ai && (
        <div className="fixed inset-0 z-50 flex flex-col bg-popover sm:inset-auto sm:bottom-6 sm:right-6 sm:h-[600px] sm:w-[400px] sm:overflow-hidden sm:rounded-2xl sm:border sm:shadow-card animate-in fade-in slide-in-from-bottom-4">
          <div className="flex items-center gap-3 border-b px-4 py-3">
            <div className="grid size-9 place-items-center rounded-full bg-gold-gradient text-primary-foreground"><Sparkles className="size-4" /></div>
            <div className="flex-1"><p className="font-semibold">AUCTRA AI</p><p className="text-xs text-success">Online · demo responses</p></div>
            <button onClick={() => setAi(false)} aria-label="Close assistant" className="grid size-9 place-items-center rounded-full hover:bg-accent"><X className="size-5" /></button>
          </div>
          <AiChat />
        </div>
      )}

      <Sheet open={menu} onOpenChange={setMenu}>
        <SheetContent side="left" className="w-[85vw] max-w-sm">
          <SheetTitle className="sr-only">Menu</SheetTitle>
          <div className="mb-6"><Logo /></div>
          <div className="space-y-1">
            {nav.map((n) => <Link key={n.to} to={n.to} className="block rounded-xl px-3 py-3 text-base font-medium hover:bg-accent">{n.label}</Link>)}
          </div>
          <p className="mb-2 mt-6 px-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">Categories</p>
          <div className="grid grid-cols-2 gap-2">
            {categories.map((c) => <Link key={c.slug} to="/explore" search={{ category: c.name }} className="rounded-xl border px-3 py-2.5 text-sm hover:border-primary/50">{c.name}</Link>)}
          </div>
        </SheetContent>
      </Sheet>

      {search && <SearchOverlay onClose={() => setSearch(false)} />}
    </div>
  );
}

function SearchOverlay({ onClose }: { onClose: () => void }) {
  const rooms = useAuctionStore((s) => s.rooms);
  const [q, setQ] = useState("");
  const results = q.trim() ? Object.values(rooms).filter((r) => `${r.title} ${r.category} ${r.location}`.toLowerCase().includes(q.toLowerCase())) : [];
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-md animate-in fade-in" onClick={onClose}>
      <div className="mx-auto mt-0 max-w-2xl bg-popover sm:mt-24 sm:rounded-2xl sm:border sm:shadow-card" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b px-4">
          <Search className="size-5 text-muted-foreground" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search cars, watches, art, homes…" className="h-16 flex-1 bg-transparent text-lg outline-none" />
          <button onClick={onClose} aria-label="Close search" className="grid size-9 place-items-center rounded-full hover:bg-accent"><X className="size-5" /></button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-2">
          {!q && <div className="flex flex-wrap gap-2 p-3">{categories.map((c) => <Link key={c.slug} to="/explore" search={{ category: c.name }} onClick={onClose} className="rounded-full border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"><LayoutGrid className="mr-1 inline size-3.5" />{c.name}</Link>)}</div>}
          {q && results.length === 0 && <p className="p-8 text-center text-muted-foreground">No lots match "{q}".</p>}
          {results.map((r) => (
            <Link key={r.id} to="/item/$id" params={{ id: r.id }} onClick={onClose} className="flex items-center gap-3 rounded-xl p-2 hover:bg-accent">
              <img src={r.images[0]} alt="" className="size-14 rounded-lg object-cover" />
              <div className="min-w-0 flex-1"><p className="truncate font-medium">{r.title}</p><p className="text-sm text-muted-foreground">{r.category} · {r.location}</p></div>
              <Gavel className="size-4 text-muted-foreground" />
            </Link>
          ))}
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
          <p className="mt-4 max-w-xs text-sm text-muted-foreground">The modern auction house for extraordinary things — from grand tourers to fine jewelry.</p>
          <form onSubmit={(e) => { e.preventDefault(); toast.success("Thanks — newsletter signup is a demo."); }} className="mt-6 flex max-w-sm gap-2">
            <input type="email" required placeholder="Email address" className="h-11 min-w-0 flex-1 rounded-xl border bg-background px-3 text-sm outline-none focus:border-primary" />
            <button className="h-11 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground">Subscribe</button>
          </form>
        </div>
        {([
          { h: "Marketplace", l: [["Explore", "/explore"], ["Live Now", "/live"], ["Sell an Item", "/sell"]] },
          { h: "Company", l: [["How It Works", "/how-it-works"], ["Admin demo", "/admin"]] },
          { h: "Help", l: [["Help Center", "/how-it-works"], ["Fees", "/how-it-works"], ["Auction Rules", "/how-it-works"]] },
          { h: "Legal", l: [["Terms", "/how-it-works"], ["Privacy", "/how-it-works"]] },
        ] as const).map((c) => (
          <div key={c.h}>
            <p className="mb-4 text-sm font-semibold">{c.h}</p>
            <ul className="space-y-2.5 text-sm text-muted-foreground">
              {c.l.map(([t, h]) => <li key={t}><Link to={h} className="hover:text-foreground">{t}</Link></li>)}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t px-4 py-6 text-center text-xs text-muted-foreground">© 2026 AUCTRA. Demo interface — figures and listings are illustrative.</div>
    </footer>
  );
}
