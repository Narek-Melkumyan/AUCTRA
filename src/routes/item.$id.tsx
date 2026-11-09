import { useState } from "react";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { MapPin, Radio, Share2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { buyerFees, fmtFull, seedAuctions } from "@/lib/auctions";
import { useRoom, useRooms } from "@/lib/auction-store";
import { AuctionCard, Countdown, StatusBadge, WatchButton } from "@/components/auction/bits";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/item/$id")({
  loader: ({ params }) => {
    const a = seedAuctions.find((x) => x.id === params.id);
    if (!a) throw notFound();
    return { title: a.title, description: a.description };
  },
  head: ({ loaderData }) => ({
    meta: [
      { title: loaderData ? `${loaderData.title} — AUCTRA` : "Lot unavailable — AUCTRA" },
      { name: "description", content: loaderData?.description ?? "Auction lot." },
      { property: "og:title", content: loaderData?.title ?? "Auction lot" },
      { property: "og:description", content: loaderData?.description ?? "Auction lot on AUCTRA." },
      { property: "og:type", content: "product" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Item,
});

function Item() {
  const { id } = Route.useParams();
  const r = useRoom(id);
  const all = Object.values(useRooms());
  const [img, setImg] = useState(0);
  if (!r) return null;
  const fees = buyerFees(r.currentBid);
  const related = all.filter((x) => x.id !== r.id && (x.category === r.category || x.status === "live")).slice(0, 4);
  return (
    <div className="mx-auto max-w-[1440px] px-4 py-10 sm:px-6 lg:px-10">
      <nav className="mb-6 text-sm text-muted-foreground"><Link to="/explore" className="hover:text-foreground">Explore</Link> / <Link to="/explore" search={{ category: r.category }} className="hover:text-foreground">{r.category}</Link></nav>
      <div className="grid gap-10 lg:grid-cols-[1.3fr_1fr]">
        <div>
          <div className="relative overflow-hidden rounded-3xl border"><img src={r.images[img]} alt={r.title} className="aspect-[4/3] w-full object-cover" /><div className="absolute left-4 top-4"><StatusBadge room={r} /></div></div>
          <div className="mt-3 flex gap-2">{r.images.map((s, i) => <button key={i} onClick={() => setImg(i)} className={cn("overflow-hidden rounded-xl border-2", i === img ? "border-primary" : "border-transparent opacity-60")}><img src={s} alt="" className="size-20 object-cover" /></button>)}</div>
          <div className="mt-10 space-y-8">
            <div><h2 className="mb-4 text-xl font-semibold">Specifications</h2><dl className="grid gap-px overflow-hidden rounded-2xl border bg-border sm:grid-cols-2">{r.specs.map(([k, v]) => <div key={k} className="flex justify-between gap-4 bg-card p-4 text-sm"><dt className="text-muted-foreground">{k}</dt><dd className="text-right font-medium">{v}</dd></div>)}</dl></div>
            <div><h2 className="mb-2 text-xl font-semibold">Condition report</h2><p className="text-muted-foreground">Seller-rated <span className="text-foreground">{r.condition}</span>. {r.inspection}</p></div>
            <div><h2 className="mb-2 text-xl font-semibold">Shipping</h2><p className="text-muted-foreground">{r.shipping}</p></div>
          </div>
        </div>
        <aside className="h-fit space-y-5 lg:sticky lg:top-24">
          <p className="text-xs uppercase tracking-widest text-muted-foreground">{r.lot} · {r.category}</p>
          <h1 className="font-display text-4xl leading-tight sm:text-5xl">{r.title}</h1>
          <p className="inline-flex items-center gap-1 text-sm text-muted-foreground"><MapPin className="size-4" />{r.location}</p>
          <div className="rounded-3xl border bg-card p-6 shadow-card">
            <div className="flex items-end justify-between">
              <div><p className="text-sm text-muted-foreground">Current bid</p><p key={r.currentBid} className="animate-bump text-4xl font-extrabold tabular">{fmtFull(r.currentBid)}</p></div>
              <div className="text-right"><p className="text-sm text-muted-foreground">{r.status === "upcoming" ? "Opens" : "Ends in"}</p><Countdown room={r} className="text-2xl font-bold" /></div>
            </div>
            <p className={cn("mt-3 text-sm", r.reserve === "met" ? "text-success" : r.reserve === "not-met" ? "text-live" : "text-muted-foreground")}>{r.reserve === "met" ? "Reserve met" : r.reserve === "not-met" ? "Reserve not yet met" : "No reserve"} · {r.bids.length} bids · {r.watchers} watching</p>
            {r.buyNow && <p className="mt-1 text-sm text-muted-foreground">Buy Now available at {fmtFull(r.buyNow)}</p>}
            <Link to="/room/$id" params={{ id: r.id }} className="mt-5 flex h-13 items-center justify-center gap-2 rounded-2xl bg-primary py-4 font-bold text-primary-foreground hover:shadow-gold"><Radio className="size-5" /> View Live Auction Room</Link>
            <div className="mt-3 flex gap-2">
              <WatchButton id={r.id} className="size-12 border" />
              <button onClick={() => { navigator.clipboard?.writeText(window.location.href); toast.success("Link copied"); }} className="inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-full border font-semibold"><Share2 className="size-4" /> Share</button>
            </div>
          </div>
          <div className="rounded-3xl border p-6 text-sm">
            <p className="mb-3 font-semibold">Fees preview (if you win now)</p>
            <div className="space-y-2 text-muted-foreground">
              <Row l="Hammer price" v={fmtFull(r.currentBid)} /><Row l="Buyer's premium (10%, max $25k)" v={fmtFull(fees.premium)} /><Row l="Platform fee" v={fmtFull(fees.platform)} />
              <div className="border-t pt-2 text-foreground"><Row l="Estimated total" v={fmtFull(fees.total)} /></div>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">Demo fee model. Excludes shipping and taxes.</p>
          </div>
          <div className="flex items-center gap-3 rounded-3xl border p-5">
            <span className="grid size-11 place-items-center rounded-full bg-accent font-bold">{r.seller[0]}</span>
            <div><p className="font-semibold">{r.seller}</p><p className="inline-flex items-center gap-1 text-xs text-muted-foreground">{r.verified && <ShieldCheck className="size-3.5 text-primary" />}{r.verified ? "Verified" : "Unverified"} {r.sellerType.toLowerCase()} seller</p></div>
          </div>
        </aside>
      </div>
      <h2 className="mb-6 mt-20 font-display text-4xl">Related auctions</h2>
      <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">{related.map((x) => <AuctionCard key={x.id} room={x} />)}</div>
    </div>
  );
}
const Row = ({ l, v }: { l: string; v: string }) => <div className="flex justify-between gap-4"><span>{l}</span><span className="tabular">{v}</span></div>;
