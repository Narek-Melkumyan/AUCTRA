import { useMemo } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AccountLayout, Empty, btn, metaFor } from "@/components/account/AccountLayout";
import { AuctionCard } from "@/components/auction/bits";
import { FavoriteButton } from "@/components/auction/FavoriteButton";
import { IS_API_MODE, useRooms } from "@/lib/auction-store";
import { useSession } from "@/lib/demo-session";
import { toRoom } from "@/lib/api/adapters";
import { errText, useFavoriteIds, useFavoriteLots } from "@/lib/api/saved";

export const Route = createFileRoute("/favorites")({
  head: () => ({
    meta: metaFor("Favourites", "Your personal shortlist of AUCTRA lots."),
  }),
  component: Favorites,
});

function Favorites() {
  const user = useSession((s) => s.user);
  const restored = useSession((s) => s.restored);
  const ids = useFavoriteIds();
  const lots = useFavoriteLots(ids.data);
  const live = useRooms();
  // Prefer the live room state (real-time price and countdown) when the lot is followed.
  const rooms = useMemo(() => {
    const byId = new Map((lots.data ?? []).map((a) => [a.id, a]));
    return (ids.data ?? []).flatMap((id) => {
      if (live[id]) return [live[id]];
      const a = byId.get(id);
      return a ? [toRoom(a, null)] : [];
    });
  }, [ids.data, lots.data, live]);

  if (!IS_API_MODE)
    return (
      <AccountLayout title="Favourites">
        <Empty
          title="Favourites need the AUCTRA server"
          body="Favourites are saved to your account, so they are not available in the offline demo. Use the watchlist instead."
          action={
            <Link to="/watchlist" className={btn}>
              Open watchlist
            </Link>
          }
        />
      </AccountLayout>
    );
  if (!restored)
    return (
      <AccountLayout title="Favourites">
        <div className="h-64 animate-pulse rounded-lg bg-muted/40" />
      </AccountLayout>
    );
  if (!user)
    return (
      <AccountLayout title="Favourites">
        <Empty
          title="Sign in to see your favourites"
          body="Star any lot to build a personal shortlist."
          action={
            <Link to="/login" className={btn}>
              Sign in
            </Link>
          }
        />
      </AccountLayout>
    );

  const count = ids.data?.length ?? 0;
  const loading = ids.isPending || (count > 0 && lots.isPending);
  return (
    <AccountLayout
      title="Favourites"
      description={
        ids.isSuccess
          ? `${count} starred lot${count === 1 ? "" : "s"} · kept separately from your watchlist`
          : "Your personal shortlist of lots"
      }
    >
      {loading ? (
        <div className="h-64 animate-pulse rounded-lg bg-muted/40" />
      ) : ids.isError || lots.isError ? (
        <p role="alert" className="rounded-lg border p-6 text-sm text-live">
          {errText(ids.error ?? lots.error, "Couldn't load your favourites.")}
        </p>
      ) : rooms.length === 0 ? (
        <Empty
          title="No favourites yet"
          body="Tap the star on any lot page to add it to this shortlist."
          action={
            <Link to="/explore" className={btn}>
              Explore auctions
            </Link>
          }
        />
      ) : (
        <ul
          aria-label="Favourite lots"
          className="grid gap-x-6 gap-y-10 sm:grid-cols-2 xl:grid-cols-3"
        >
          {rooms.map((r) => (
            <li key={r.id} className="relative">
              <AuctionCard room={r} />
              {/* Beside the card's own watchlist heart (top-right of the photo). */}
              <FavoriteButton id={r.id} className="absolute right-12 top-2.5 z-10" />
            </li>
          ))}
        </ul>
      )}
    </AccountLayout>
  );
}
