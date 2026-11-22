import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronDown, LayoutGrid, List, SearchX, SlidersHorizontal, X } from "lucide-react";
import { AuctionCard } from "@/components/auction/bits";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { api } from "@/lib/api/client";
import { toRoom } from "@/lib/api/adapters";
import { findCategory, useCategories } from "@/lib/api/categories";
import type { AuctionDto } from "@/lib/api/types";
import { useRooms } from "@/lib/auction-store";
import { cn } from "@/lib/utils";
import { Check, Group } from "./FilterControls";

export type ExploreSearch = {
  category?: string | undefined;
  status?: "live" | "upcoming" | "ended" | undefined;
  q?: string | undefined;
};

const PAGE_SIZE = 24;
const SORTS = {
  ending_soon: "Ending soon",
  newest: "Newly listed",
  price_asc: "Lowest current bid",
  price_desc: "Highest current bid",
  most_bids: "Most bids",
} as const;
const CONDITIONS = [
  ["NEW", "New"],
  ["EXCELLENT", "Excellent"],
  ["VERY_GOOD", "Very good"],
  ["GOOD", "Good"],
  ["FAIR", "Fair"],
] as const;
const SELLERS = [
  ["DEALER", "Dealer"],
  ["BUSINESS", "Business"],
  ["PRIVATE", "Private"],
] as const;

type Page = { items: AuctionDto[]; total: number; page: number; limit: number };

function useDebounced<T>(value: T, ms = 350): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Explore in API mode: every filter, sort and page is answered by PostgreSQL, so the
 * results, counts and categories always reflect the full catalogue (not just the lots the
 * browser happens to have loaded). Categories come from the database, including ones an
 * administrator created after the app was built.
 */
export function ApiExplore({ search }: { search: ExploreSearch }) {
  const navigate = useNavigate();
  const cats = useCategories();
  const liveRooms = useRooms();
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const [drawer, setDrawer] = useState(false);
  const [q, setQ] = useState(search.q ?? "");
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [conditions, setConditions] = useState<string[]>([]);
  const [seller, setSeller] = useState("");
  const [reserve, setReserve] = useState("");
  const [sort, setSort] = useState<keyof typeof SORTS>("ending_soon");
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);
  const dq = useDebounced(q);
  const dmin = useDebounced(min);
  const dmax = useDebounced(max);
  const category = search.category;
  const status = search.status;

  // Any filter change goes back to page 1.
  useEffect(
    () => setPage(1),
    [category, status, dq, dmin, dmax, conditions, seller, reserve, sort],
  );

  const params = useMemo(() => {
    const p = new URLSearchParams({
      phase: status ?? "all",
      sort,
      limit: String(PAGE_SIZE),
      page: String(page),
    });
    if (category) p.set("category", category);
    if (dq.trim()) p.set("q", dq.trim());
    if (dmin) p.set("minPrice", dmin);
    if (dmax) p.set("maxPrice", dmax);
    if (conditions.length) p.set("condition", conditions.join(","));
    if (seller) p.set("sellerType", seller);
    if (reserve) p.set("reserve", reserve);
    return p.toString();
  }, [category, status, dq, dmin, dmax, conditions, seller, reserve, sort, page]);

  const res = useQuery({
    queryKey: ["explore", params],
    queryFn: () => api<Page>(`/auctions?${params}`),
    placeholderData: keepPreviousData,
  });

  // Prefer the live-synced copy of a lot when the store follows it (fresher price/clock).
  const results = useMemo(
    () => (res.data?.items ?? []).map((a) => liveRooms[a.id] ?? toRoom(a, null)),
    [res.data, liveRooms],
  );
  const total = res.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = findCategory(cats.data, category);
  const go = (next: Partial<ExploreSearch>) =>
    void navigate({
      to: "/explore",
      search: {
        ...(next.category !== undefined
          ? next.category
            ? { category: next.category }
            : {}
          : category
            ? { category }
            : {}),
        ...(next.status !== undefined
          ? next.status
            ? { status: next.status }
            : {}
          : status
            ? { status }
            : {}),
      },
    });
  const toggle = (list: string[], v: string, set: (x: string[]) => void) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const panel = (
    <div className="space-y-7 text-sm">
      <Group title="Category">
        <Check label="All categories" on={!category} onClick={() => go({ category: "" })} />
        {cats.isPending && <div className="h-40 animate-pulse rounded-lg bg-muted/40" />}
        {cats.data?.map((c) => {
          const open = expanded === c.slug || current?.parent?.slug === c.slug;
          return (
            <div key={c.slug}>
              <div className="flex items-center">
                <div className="min-w-0 flex-1">
                  <Check
                    label={`${c.name} (${c.activeAuctionCount ?? 0})`}
                    on={category === c.slug}
                    onClick={() => go({ category: category === c.slug ? "" : c.slug })}
                  />
                </div>
                {c.subcategories.length > 0 && (
                  <button
                    aria-label={`${open ? "Hide" : "Show"} ${c.name} subcategories`}
                    aria-expanded={open}
                    onClick={() => setExpanded(open ? null : c.slug)}
                    className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent"
                  >
                    <ChevronDown className={cn("size-4 transition", open && "rotate-180")} />
                  </button>
                )}
              </div>
              {open && (
                <div className="ml-6 border-l pl-2">
                  {c.subcategories.map((s) => (
                    <Check
                      key={s.slug}
                      label={`${s.name} (${s.activeAuctionCount ?? 0})`}
                      on={category === s.slug}
                      onClick={() => go({ category: category === s.slug ? c.slug : s.slug })}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </Group>
      <Group title="Auction status">
        {(
          [
            ["", "All"],
            ["live", "Live"],
            ["upcoming", "Upcoming"],
            ["ended", "Ended"],
          ] as const
        ).map(([v, l]) => (
          <Check
            key={l}
            label={l}
            on={(status ?? "") === v}
            onClick={() => go({ status: v || undefined } as Partial<ExploreSearch>)}
          />
        ))}
      </Group>
      <Group title="Current bid">
        <div className="flex gap-2">
          {(
            [
              ["Min", min, setMin],
              ["Max", max, setMax],
            ] as const
          ).map(([label, value, set]) => (
            <input
              key={label}
              inputMode="numeric"
              placeholder={label}
              aria-label={`${label} price`}
              value={value}
              onChange={(e) => set(e.target.value.replace(/\D/g, ""))}
              className="h-10 w-full rounded-lg border bg-background px-3 outline-none focus:border-primary"
            />
          ))}
        </div>
      </Group>
      <Group title="Condition">
        {CONDITIONS.map(([v, l]) => (
          <Check
            key={v}
            label={l}
            on={conditions.includes(v)}
            onClick={() => toggle(conditions, v, setConditions)}
          />
        ))}
      </Group>
      <Group title="Seller type">
        {SELLERS.map(([v, l]) => (
          <Check
            key={v}
            label={l}
            on={seller === v}
            onClick={() => setSeller(seller === v ? "" : v)}
          />
        ))}
      </Group>
      <Group title="Reserve">
        {(
          [
            ["none", "No reserve"],
            ["met", "Reserve met"],
            ["not_met", "Reserve not met"],
          ] as const
        ).map(([v, l]) => (
          <Check
            key={v}
            label={l}
            on={reserve === v}
            onClick={() => setReserve(reserve === v ? "" : v)}
          />
        ))}
      </Group>
      <button
        onClick={() => {
          setQ("");
          setMin("");
          setMax("");
          setConditions([]);
          setSeller("");
          setReserve("");
          void navigate({ to: "/explore", search: {} });
        }}
        className="w-full rounded-lg border py-2.5 font-semibold hover:bg-accent"
      >
        Clear all filters
      </button>
    </div>
  );

  const heading = current?.node.name ?? "All auctions";
  return (
    <div className="mx-auto max-w-[1440px] px-4 py-10 sm:px-6 lg:px-10">
      <nav className="mb-3 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>{" "}
        /{" "}
        {current?.parent && (
          <>
            <Link
              to="/explore"
              search={{ category: current.parent.slug }}
              className="hover:text-foreground"
            >
              {current.parent.name}
            </Link>{" "}
            /{" "}
          </>
        )}
        <span className="text-foreground">{heading}</span>
      </nav>
      <h1 className="font-display text-5xl sm:text-4xl">
        {current ? current.node.name : "Explore Auctions"}
      </h1>
      {current?.node.description && (
        <p className="mt-2 max-w-2xl text-muted-foreground">{current.node.description}</p>
      )}
      <div className="mt-8 flex flex-wrap items-center gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search titles and descriptions…"
          aria-label="Search auctions"
          className="h-11 min-w-0 flex-1 rounded-xl border bg-card px-4 outline-none focus:border-primary sm:max-w-sm"
        />
        <button
          onClick={() => setDrawer(true)}
          className="inline-flex h-11 items-center gap-2 rounded-xl border px-4 font-medium lg:hidden"
        >
          <SlidersHorizontal className="size-4" /> Filters
        </button>
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {res.isPending ? "Loading…" : `${total.toLocaleString()} result${total === 1 ? "" : "s"}`}
        </p>
        <div className="ml-auto flex items-center gap-2">
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as keyof typeof SORTS)}
            aria-label="Sort"
            className="h-11 rounded-xl border bg-card px-3 text-sm outline-none"
          >
            {Object.entries(SORTS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <div className="hidden rounded-xl border p-1 sm:flex">
            {(["grid", "list"] as const).map((l) => (
              <button
                key={l}
                aria-label={`${l} view`}
                onClick={() => setLayout(l)}
                className={cn(
                  "grid size-9 place-items-center rounded-lg",
                  layout === l && "bg-accent",
                )}
              >
                {l === "grid" ? <LayoutGrid className="size-4" /> : <List className="size-4" />}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-8 grid gap-10 lg:grid-cols-[260px_1fr]">
        <aside className="sticky top-24 hidden h-fit max-h-[calc(100vh-7rem)] overflow-y-auto pr-2 lg:block">
          {panel}
        </aside>
        <div className={cn(res.isFetching && !res.isPending && "opacity-70 transition")}>
          {res.isError ? (
            <p className="rounded-xl border p-6 text-sm text-live">
              Couldn't load auctions. Check your connection and try again.
            </p>
          ) : res.isPending ? (
            <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="aspect-[4/5] animate-pulse rounded-2xl bg-muted/40" />
              ))}
            </div>
          ) : results.length === 0 ? (
            <div className="grid place-items-center rounded-3xl border border-dashed py-24 text-center">
              <SearchX className="size-10 text-muted-foreground" />
              <p className="mt-4 text-xl font-semibold">No auctions match these filters</p>
              <p className="mt-1 text-muted-foreground">
                Try widening your price range or clearing a filter.
              </p>
            </div>
          ) : (
            <>
              <div
                className={cn(
                  "grid gap-6",
                  layout === "grid" ? "sm:grid-cols-2 xl:grid-cols-3" : "grid-cols-1",
                )}
              >
                {results.map((r) => (
                  <AuctionCard key={r.id} room={r} layout={layout} />
                ))}
              </div>
              {pages > 1 && (
                <nav
                  aria-label="Pagination"
                  className="mt-10 flex items-center justify-between gap-3 text-sm"
                >
                  <button
                    disabled={page <= 1}
                    onClick={() => {
                      setPage(page - 1);
                      window.scrollTo({ top: 0 });
                    }}
                    className="h-10 rounded-xl border px-4 font-medium disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <span className="text-muted-foreground">
                    Page {page} of {pages}
                  </span>
                  <button
                    disabled={page >= pages}
                    onClick={() => {
                      setPage(page + 1);
                      window.scrollTo({ top: 0 });
                    }}
                    className="h-10 rounded-xl border px-4 font-medium disabled:opacity-40"
                  >
                    Next
                  </button>
                </nav>
              )}
            </>
          )}
        </div>
      </div>
      <Sheet open={drawer} onOpenChange={setDrawer}>
        <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto rounded-t-3xl">
          <div className="mb-4 flex items-center justify-between">
            <SheetTitle>Filters</SheetTitle>
            <button onClick={() => setDrawer(false)} aria-label="Close">
              <X className="size-5" />
            </button>
          </div>
          {panel}
        </SheetContent>
      </Sheet>
    </div>
  );
}
