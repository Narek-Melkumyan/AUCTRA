import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { AccountLayout, Empty, Stat, btn, metaFor } from "@/components/account/AccountLayout";
import { Countdown } from "@/components/auction/bits";
import { useAuctionStore, useRooms } from "@/lib/auction-store";
import { useSession, orderStatusLabel } from "@/lib/demo-session";
import { fmt } from "@/lib/auctions";

export const Route = createFileRoute("/dashboard")({
  head: () => ({ meta: metaFor("Buyer dashboard", "Your active bids, watchlist, wins and orders on AUCTRA.") }),
  component: Dashboard,
});

function Dashboard() {
  const rooms = Object.values(useRooms());
  const watch = useAuctionStore((s) => s.watchlist);
  const user = useSession((s) => s.user);
  const orders = useSession((s) => s.orders);
  const mine = rooms.filter((r) => r.bids.some((b) => b.mine));
  const leading = mine.filter((r) => r.bids[0]?.mine && r.status === "live");
  const won = mine.filter((r) => r.bids[0]?.mine && r.status === "ended");
  return (
    <AccountLayout title={user ? `Welcome back, ${user.name}` : "Buyer dashboard"} description="Demo data — activity reflects bids placed in this browser.">
      {!user && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4 text-sm">
          <span className="text-muted-foreground">You're browsing as a guest. Sign in to the demo to personalise this page.</span>
          <Link to="/login" className={btn}>Sign in</Link>
        </div>
      )}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border md:grid-cols-4">
        <Stat label="Active bids" value={mine.filter((r) => r.status === "live").length} />
        <Stat label="Leading" value={leading.length} />
        <Stat label="Won" value={won.length} />
        <Stat label="Watching" value={watch.length} />
      </div>

      <div className="mt-10 grid gap-10 xl:grid-cols-2">
        <div>
          <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-medium">Your bids</h2><Link to="/bids" className="text-xs text-muted-foreground hover:text-foreground">View all</Link></div>
          {mine.length === 0 ? (
            <Empty title="No bids yet" body="Join a live room and place a demo bid to see it here." action={<Link to="/live" className={btn}>Browse live auctions <ArrowRight className="size-4" /></Link>} />
          ) : (
            <ul className="divide-y rounded-lg border bg-card">
              {mine.slice(0, 5).map((r) => (
                <li key={r.id}><Link to="/room/$id" params={{ id: r.id }} className="flex items-center gap-3 p-3 hover:bg-accent">
                  <img src={r.images[0]} alt="" className="size-10 rounded-md object-cover" />
                  <span className="min-w-0 flex-1 truncate text-sm">{r.title}</span>
                  <span className={r.bids[0]?.mine ? "text-xs text-success" : "text-xs text-live"}>{r.bids[0]?.mine ? (r.status === "ended" ? "Won" : "Leading") : r.status === "ended" ? "Lost" : "Outbid"}</span>
                  <span className="w-24 text-right text-sm tabular">{fmt(r.currentBid)}</span>
                </Link></li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-medium">Watching</h2><Link to="/watchlist" className="text-xs text-muted-foreground hover:text-foreground">View all</Link></div>
          <ul className="divide-y rounded-lg border bg-card">
            {rooms.filter((r) => watch.includes(r.id)).slice(0, 5).map((r) => (
              <li key={r.id}><Link to="/item/$id" params={{ id: r.id }} className="flex items-center gap-3 p-3 hover:bg-accent">
                <img src={r.images[0]} alt="" className="size-10 rounded-md object-cover" />
                <span className="min-w-0 flex-1 truncate text-sm">{r.title}</span>
                <Countdown room={r} className="text-xs text-muted-foreground" />
              </Link></li>
            ))}
            {watch.length === 0 && <li className="p-4 text-sm text-muted-foreground">Nothing saved yet.</li>}
          </ul>
        </div>
      </div>

      <div className="mt-10">
        <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-medium">Recent orders</h2><Link to="/orders" className="text-xs text-muted-foreground hover:text-foreground">Order history</Link></div>
        <ul className="divide-y rounded-lg border bg-card">
          {orders.slice(0, 3).map((o) => (
            <li key={o.id} className="flex items-center gap-3 p-3 text-sm">
              <span className="w-24 shrink-0 text-xs text-muted-foreground tabular">{o.id}</span>
              <span className="min-w-0 flex-1 truncate">{o.title}</span>
              <span className="hidden text-xs text-muted-foreground sm:inline">{orderStatusLabel[o.status]}</span>
              <span className="w-24 text-right tabular">{fmt(o.hammer)}</span>
            </li>
          ))}
        </ul>
      </div>
    </AccountLayout>
  );
}
