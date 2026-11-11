import { createFileRoute, Link } from "@tanstack/react-router";
import { AccountLayout, Empty, btn, metaFor } from "@/components/account/AccountLayout";
import { AuctionCard } from "@/components/auction/bits";
import { useAuctionStore, useRooms } from "@/lib/auction-store";

export const Route = createFileRoute("/watchlist")({
  head: () => ({ meta: metaFor("Watchlist", "Lots you're keeping an eye on across AUCTRA.") }),
  component: Watchlist,
});

function Watchlist() {
  const ids = useAuctionStore((s) => s.watchlist);
  const rooms = Object.values(useRooms()).filter((r) => ids.includes(r.id));
  return (
    <AccountLayout title="Watchlist" description={`${rooms.length} saved lot${rooms.length === 1 ? "" : "s"}`}>
      {rooms.length === 0 ? (
        <Empty title="Your watchlist is empty" body="Tap the heart on any lot to save it here." action={<Link to="/explore" className={btn}>Explore auctions</Link>} />
      ) : (
        <div className="grid gap-x-6 gap-y-10 sm:grid-cols-2 xl:grid-cols-3">{rooms.map((r) => <AuctionCard key={r.id} room={r} />)}</div>
      )}
    </AccountLayout>
  );
}
