import { Link } from "@tanstack/react-router";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { AuctionCard, SectionHeading } from "@/components/auction/bits";
import { api } from "@/lib/api/client";
import { toRoom } from "@/lib/api/adapters";
import type { AuctionDto } from "@/lib/api/types";
import { useRooms } from "@/lib/auction-store";

type Page = { items: AuctionDto[]; total: number; page: number; limit: number };
const PAGE = 24;

/**
 * Live Now in API mode: live rooms are paged from the server (soonest-ending first), so the
 * page stays fast and complete however large the catalogue is. Upcoming and recently closed
 * lots show a short preview with links into Explore.
 */
export function ApiLive() {
  const rooms = useRooms();
  const live = useInfiniteQuery({
    queryKey: ["live-now"],
    queryFn: ({ pageParam }) =>
      api<Page>(`/auctions?phase=live&sort=ending_soon&limit=${PAGE}&page=${pageParam}`),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.limit < last.total ? last.page + 1 : undefined),
    refetchInterval: 60_000,
  });
  const upcoming = useQuery({
    queryKey: ["live-now", "upcoming"],
    queryFn: () => api<Page>("/auctions?phase=upcoming&sort=ending_soon&limit=8"),
  });
  const ended = useQuery({
    queryKey: ["live-now", "ended"],
    queryFn: () => api<Page>("/auctions?phase=ended&sort=recently_ended&limit=8"),
  });
  // Prefer the live-synced copy of a lot when the store follows it.
  const cards = (items: AuctionDto[] | undefined) =>
    (items ?? []).map((a) => rooms[a.id] ?? toRoom(a, null));
  const liveItems = live.data?.pages.flatMap((p) => p.items);
  const total = live.data?.pages[0]?.total;

  return (
    <div className="mx-auto max-w-[1440px] px-4 py-12 sm:px-6 lg:px-10">
      <h1 className="font-display text-5xl sm:text-7xl">
        Live <span className="italic text-gold-gradient">Now</span>
      </h1>
      <p className="mt-3 max-w-xl text-muted-foreground">
        {total !== undefined
          ? `${total.toLocaleString()} rooms open right now, soonest-ending first. Each runs independently — its own clock, bids and chat.`
          : "Each room runs independently — its own clock, bids, chat and participants."}
      </p>
      {live.isError ? (
        <p className="mt-12 rounded-xl border p-6 text-sm text-live">
          Couldn't load live auctions. Check your connection and try again.
        </p>
      ) : live.isPending ? (
        <div className="mt-12 grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="aspect-[4/5] animate-pulse rounded-2xl bg-muted/40" />
          ))}
        </div>
      ) : (
        <>
          <div className="mt-12 grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
            {cards(liveItems).map((r) => (
              <AuctionCard key={r.id} room={r} />
            ))}
          </div>
          {live.hasNextPage && (
            <div className="mt-10 text-center">
              <button
                onClick={() => void live.fetchNextPage()}
                disabled={live.isFetchingNextPage}
                className="h-11 rounded-xl border px-6 font-medium disabled:opacity-40"
              >
                {live.isFetchingNextPage
                  ? "Loading…"
                  : `Show more (${(total! - liveItems!.length).toLocaleString()} more live)`}
              </button>
            </div>
          )}
        </>
      )}
      {(upcoming.data?.items.length ?? 0) > 0 && (
        <div className="mt-20">
          <SectionHeading eyebrow="Scheduled" title="Starting Later" />
          <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
            {cards(upcoming.data?.items).map((r) => (
              <AuctionCard key={r.id} room={r} />
            ))}
          </div>
          {upcoming.data!.total > upcoming.data!.items.length && (
            <Link
              to="/explore"
              search={{ status: "upcoming" }}
              className="mt-6 inline-block text-sm font-medium underline-offset-4 hover:underline"
            >
              See all {upcoming.data!.total.toLocaleString()} upcoming auctions
            </Link>
          )}
        </div>
      )}
      {(ended.data?.items.length ?? 0) > 0 && (
        <div className="mt-20">
          <SectionHeading eyebrow="Results" title="Recently Closed" />
          <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
            {cards(ended.data?.items).map((r) => (
              <AuctionCard key={r.id} room={r} />
            ))}
          </div>
          <Link
            to="/explore"
            search={{ status: "ended" }}
            className="mt-6 inline-block text-sm font-medium underline-offset-4 hover:underline"
          >
            See all results
          </Link>
        </div>
      )}
    </div>
  );
}
