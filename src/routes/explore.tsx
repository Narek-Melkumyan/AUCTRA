import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { LayoutGrid, List, SlidersHorizontal, X, SearchX } from "lucide-react";
import { categories, type Category } from "@/lib/auctions";
import { useAuctionStore, useRooms, type RoomState } from "@/lib/auction-store";
import { AuctionCard } from "@/components/auction/bits";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

type Search = { category?: string; watchlist?: boolean; status?: "live" | "upcoming" | "ended" };

export const Route = createFileRoute("/explore")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    category: typeof s.category === "string" ? s.category : undefined,
    watchlist: s.watchlist === true || s.watchlist === "true" ? true : undefined,
    status: s.status === "live" || s.status === "upcoming" || s.status === "ended" ? s.status : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Explore Auctions — AUCTRA" },
      { name: "description", content: "Browse and filter live and upcoming auctions across every category." },
      { property: "og:title", content: "Explore Auctions — AUCTRA" },
      { property: "og:description", content: "Filter by category, price, condition, reserve and more." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Explore,
});

type Filters = {
  q: string; cats: string[]; status: string[]; min: string; max: string; conditions: string[];
  seller: string[]; reserve: string[]; buyNow: boolean; verified: boolean; endingSoon: boolean; location: string;
};
const sorts = { ending: "Ending Soon", new: "Newly Listed", low: "Lowest Current Bid", high: "Highest Current Bid", popular: "Most Popular", watched: "Most Watched" } as const;

export function filterRooms(rooms: RoomState[], f: Filters, now: number, watch?: string[]) {
  return rooms.filter((r) => {
    if (watch && !watch.includes(r.id)) return false;
    if (f.q && !`${r.title} ${r.category} ${r.location}`.toLowerCase().includes(f.q.toLowerCase())) return false;
    if (f.cats.length && !f.cats.includes(r.category)) return false;
    if (f.status.length && !f.status.includes(r.status)) return false;
    if (f.min && r.currentBid < Number(f.min)) return false;
    if (f.max && r.currentBid > Number(f.max)) return false;
    if (f.conditions.length && !f.conditions.includes(r.condition)) return false;
    if (f.seller.length && !f.seller.includes(r.sellerType)) return false;
    if (f.reserve.length && !f.reserve.includes(r.reserve)) return false;
    if (f.buyNow && !r.buyNow) return false;
    if (f.verified && !r.verified) return false;
    if (f.endingSoon && !(r.status === "live" && r.endsAt - now < 10 * 60 * 1000)) return false;
    if (f.location && !r.location.toLowerCase().includes(f.location.toLowerCase())) return false;
    return true;
  });
}

function Explore() {
  const search = Route.useSearch();
  const rooms = Object.values(useRooms());
  const watchlist = useAuctionStore((s) => s.watchlist);
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const [sort, setSort] = useState<keyof typeof sorts>("ending");
  const [drawer, setDrawer] = useState(false);
  const blank: Filters = { q: "", cats: search.category ? [search.category] : [], status: search.status ? [search.status] : [], min: "", max: "", conditions: [], seller: [], reserve: [], buyNow: false, verified: false, endingSoon: false, location: "" };
  const [f, setF] = useState<Filters>(blank);
  const [lastSearch, setLastSearch] = useState(search);
  if (lastSearch !== search) { setLastSearch(search); setF(blank); }

  const results = useMemo(() => {
    const now = Date.now();
    const list = filterRooms(rooms, f, now, search.watchlist ? watchlist : undefined);
    const by: Record<string, (a: RoomState, b: RoomState) => number> = {
      ending: (a, b) => (a.status === "live" ? a.endsAt : 9e15) - (b.status === "live" ? b.endsAt : 9e15),
      new: (a, b) => a.listedDaysAgo - b.listedDaysAgo,
      low: (a, b) => a.currentBid - b.currentBid,
      high: (a, b) => b.currentBid - a.currentBid,
      popular: (a, b) => b.bids.length - a.bids.length,
      watched: (a, b) => b.watchers - a.watchers,
    };
    return list.sort(by[sort]);
  }, [rooms, f, sort, search.watchlist, watchlist]);

  const toggle = (k: "cats" | "status" | "conditions" | "seller" | "reserve", v: string) =>
    setF((p) => ({ ...p, [k]: p[k].includes(v) ? p[k].filter((x) => x !== v) : [...p[k], v] }));

  const panel = (
    <div className="space-y-7 text-sm">
      <Group title="Category">{categories.map((c) => <Check key={c.name} label={c.name} on={f.cats.includes(c.name)} onClick={() => toggle("cats", c.name as Category)} />)}</Group>
      <Group title="Auction status">{["live", "upcoming", "ended"].map((s) => <Check key={s} label={s[0].toUpperCase() + s.slice(1)} on={f.status.includes(s)} onClick={() => toggle("status", s)} />)}</Group>
      <Group title="Current bid ($)">
        <div className="flex gap-2">
          <input inputMode="numeric" placeholder="Min" value={f.min} onChange={(e) => setF({ ...f, min: e.target.value.replace(/\D/g, "") })} className="h-10 w-full rounded-lg border bg-background px-3 outline-none focus:border-primary" />
          <input inputMode="numeric" placeholder="Max" value={f.max} onChange={(e) => setF({ ...f, max: e.target.value.replace(/\D/g, "") })} className="h-10 w-full rounded-lg border bg-background px-3 outline-none focus:border-primary" />
        </div>
      </Group>
      <Group title="Location"><input placeholder="City or country" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} className="h-10 w-full rounded-lg border bg-background px-3 outline-none focus:border-primary" /></Group>
      <Group title="Condition">{["New", "Excellent", "Very Good", "Good", "Fair"].map((c) => <Check key={c} label={c} on={f.conditions.includes(c)} onClick={() => toggle("conditions", c)} />)}</Group>
      <Group title="Seller type">{["Dealer", "Private"].map((c) => <Check key={c} label={c} on={f.seller.includes(c)} onClick={() => toggle("seller", c)} />)}</Group>
      <Group title="Reserve">{[["none", "No reserve"], ["met", "Reserve met"], ["not-met", "Reserve not met"]].map(([v, l]) => <Check key={v} label={l} on={f.reserve.includes(v)} onClick={() => toggle("reserve", v)} />)}</Group>
      <Group title="More">
        <Check label="Ending within 10 min" on={f.endingSoon} onClick={() => setF({ ...f, endingSoon: !f.endingSoon })} />
        <Check label="Buy Now available" on={f.buyNow} onClick={() => setF({ ...f, buyNow: !f.buyNow })} />
        <Check label="Verified sellers only" on={f.verified} onClick={() => setF({ ...f, verified: !f.verified })} />
      </Group>
      <button onClick={() => setF({ ...blank, cats: [], status: [] })} className="w-full rounded-lg border py-2.5 font-semibold hover:bg-accent">Clear all filters</button>
    </div>
  );

  return (
    <div className="mx-auto max-w-[1440px] px-4 py-10 sm:px-6 lg:px-10">
      <nav className="mb-3 text-sm text-muted-foreground"><Link to="/" className="hover:text-foreground">Home</Link> / <span className="text-foreground">{search.watchlist ? "Watchlist" : f.cats.length === 1 ? f.cats[0] : "All auctions"}</span></nav>
      <h1 className="font-display text-5xl sm:text-6xl">{search.watchlist ? "Your Watchlist" : "Explore Auctions"}</h1>
      <div className="mt-8 flex flex-wrap items-center gap-3">
        <input value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="Search within results…" className="h-11 min-w-0 flex-1 rounded-xl border bg-card px-4 outline-none focus:border-primary sm:max-w-sm" />
        <button onClick={() => setDrawer(true)} className="inline-flex h-11 items-center gap-2 rounded-xl border px-4 font-medium lg:hidden"><SlidersHorizontal className="size-4" /> Filters</button>
        <p className="text-sm text-muted-foreground">{results.length} result{results.length !== 1 && "s"}</p>
        <div className="ml-auto flex items-center gap-2">
          <select value={sort} onChange={(e) => setSort(e.target.value as keyof typeof sorts)} aria-label="Sort" className="h-11 rounded-xl border bg-card px-3 text-sm outline-none">
            {Object.entries(sorts).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <div className="hidden rounded-xl border p-1 sm:flex">
            {(["grid", "list"] as const).map((l) => (
              <button key={l} aria-label={`${l} view`} onClick={() => setLayout(l)} className={cn("grid size-9 place-items-center rounded-lg", layout === l && "bg-accent")}>{l === "grid" ? <LayoutGrid className="size-4" /> : <List className="size-4" />}</button>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-8 grid gap-10 lg:grid-cols-[260px_1fr]">
        <aside className="sticky top-24 hidden h-fit max-h-[calc(100vh-7rem)] overflow-y-auto pr-2 lg:block">{panel}</aside>
        <div>
          {results.length === 0 ? (
            <div className="grid place-items-center rounded-3xl border border-dashed py-24 text-center">
              <SearchX className="size-10 text-muted-foreground" />
              <p className="mt-4 text-xl font-semibold">No auctions match these filters</p>
              <p className="mt-1 text-muted-foreground">Try widening your price range or clearing a filter.</p>
            </div>
          ) : (
            <div className={cn("grid gap-6", layout === "grid" ? "sm:grid-cols-2 xl:grid-cols-3" : "grid-cols-1")}>
              {results.map((r) => <AuctionCard key={r.id} room={r} layout={layout} />)}
            </div>
          )}
        </div>
      </div>
      <Sheet open={drawer} onOpenChange={setDrawer}>
        <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto rounded-t-3xl">
          <div className="mb-4 flex items-center justify-between"><SheetTitle>Filters</SheetTitle><button onClick={() => setDrawer(false)} aria-label="Close"><X className="size-5" /></button></div>
          {panel}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return <div><p className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">{title}</p><div className="space-y-1">{children}</div></div>;
}
function Check({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-3 rounded-lg px-1 py-1.5 text-left hover:text-foreground">
      <span className={cn("grid size-4 place-items-center rounded border", on && "border-primary bg-primary")}>{on && <span className="size-1.5 rounded-sm bg-primary-foreground" />}</span>
      <span className={on ? "text-foreground" : "text-muted-foreground"}>{label}</span>
    </button>
  );
}
