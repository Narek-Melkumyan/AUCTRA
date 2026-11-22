import { createFileRoute, Link } from "@tanstack/react-router";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { AuctionCard } from "@/components/auction/bits";
import { metaFor } from "@/components/account/AccountLayout";
import { api, ApiError } from "@/lib/api/client";
import { toRoom } from "@/lib/api/adapters";
import type { AuctionDto } from "@/lib/api/types";
import { IS_API_MODE, useRooms } from "@/lib/auction-store";

type PublicProfile = {
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  memberSince: string;
  seller: { type: string; businessName: string | null; verified: boolean } | null;
};
type Page = { items: AuctionDto[]; total: number; page: number; limit: number };

export const Route = createFileRoute("/sellers/$handle")({
  head: ({ params }) => ({
    meta: metaFor(`@${params.handle} — seller`, "Seller profile and their auctions on AUCTRA."),
  }),
  component: SellerPage,
});

function SellerPage() {
  const { handle } = Route.useParams();
  const rooms = useRooms();
  const profile = useQuery({
    queryKey: ["seller", handle],
    queryFn: () => api<PublicProfile>(`/users/${encodeURIComponent(handle)}`),
    enabled: IS_API_MODE,
    retry: false,
  });
  const lots = useInfiniteQuery({
    queryKey: ["seller", handle, "lots"],
    queryFn: ({ pageParam }) =>
      api<Page>(
        `/auctions?seller=${encodeURIComponent(handle)}&phase=all&sort=ending_soon&limit=12&page=${pageParam}`,
      ),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.limit < last.total ? last.page + 1 : undefined),
    enabled: IS_API_MODE && profile.isSuccess,
  });

  if (!IS_API_MODE)
    return (
      <p className="mx-auto max-w-xl px-4 py-24 text-center">
        Seller profiles need the AUCTRA server.
      </p>
    );
  if (profile.isPending)
    return (
      <div className="mx-auto mt-16 h-40 max-w-[1440px] animate-pulse rounded-2xl bg-muted/40" />
    );
  if (profile.isError)
    return (
      <div className="mx-auto max-w-md px-4 py-24 text-center">
        <h1 className="font-display text-3xl">
          {profile.error instanceof ApiError && profile.error.status === 404
            ? "Seller not found"
            : "Couldn't load this seller"}
        </h1>
        <Link to="/explore" className="mt-6 inline-block underline">
          Browse auctions
        </Link>
      </div>
    );
  const p = profile.data;
  const items = lots.data?.pages.flatMap((x) => x.items) ?? [];
  const total = lots.data?.pages[0]?.total ?? 0;
  return (
    <div className="mx-auto max-w-[1440px] px-4 py-12 sm:px-6 lg:px-10">
      <div className="flex flex-wrap items-center gap-5 border-b pb-8">
        <span className="grid size-16 place-items-center rounded-full bg-accent text-2xl font-semibold">
          {p.displayName[0]}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-4xl">{p.displayName}</h1>
          <p className="mt-1 inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <span>@{p.handle}</span>
            {p.seller && (
              <span className="inline-flex items-center gap-1">
                {p.seller.verified && <ShieldCheck className="size-4 text-primary" />}
                {p.seller.verified ? "Verified" : "Unverified"} {p.seller.type.toLowerCase()} seller
              </span>
            )}
            <span>
              Member since{" "}
              {new Date(p.memberSince).toLocaleDateString([], { month: "long", year: "numeric" })}
            </span>
          </p>
          {p.bio && <p className="mt-3 max-w-2xl text-sm">{p.bio}</p>}
        </div>
      </div>
      <h2 className="mt-10 text-xl font-semibold">
        Auctions{" "}
        {lots.isSuccess && (
          <span className="text-muted-foreground">({total.toLocaleString()})</span>
        )}
      </h2>
      {lots.isPending ? (
        <div className="mt-6 h-64 animate-pulse rounded-2xl bg-muted/40" />
      ) : items.length === 0 ? (
        <p className="mt-6 text-muted-foreground">No public auctions yet.</p>
      ) : (
        <div className="mt-6 grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
          {items.map((a) => (
            <AuctionCard key={a.id} room={rooms[a.id] ?? toRoom(a, null)} />
          ))}
        </div>
      )}
      {lots.hasNextPage && (
        <div className="mt-10 text-center">
          <button
            onClick={() => void lots.fetchNextPage()}
            disabled={lots.isFetchingNextPage}
            className="h-11 rounded-xl border px-6 font-medium disabled:opacity-40"
          >
            {lots.isFetchingNextPage ? "Loading…" : "Show more"}
          </button>
        </div>
      )}
    </div>
  );
}
