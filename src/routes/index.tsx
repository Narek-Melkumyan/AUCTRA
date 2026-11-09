import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, BadgeCheck, Eye, Gavel, Lock, Scale, Search, ShieldCheck, Sparkles, Trophy, UserCheck } from "lucide-react";
import { categories, collections, images } from "@/lib/auctions";
import { useRooms } from "@/lib/auction-store";
import { AuctionCard, Countdown, SectionHeading } from "@/components/auction/bits";
import { AiChat } from "@/components/ai/AiChat";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "AUCTRA — Extraordinary Finds. Unmatched Possibilities." },
      { name: "description", content: "Live online auctions for cars, luxury watches, real estate, jewelry, art and collectibles." },
      { property: "og:title", content: "AUCTRA — Extraordinary Finds. Unmatched Possibilities." },
      { property: "og:description", content: "Discover, bid, and win across the world's most exciting online auctions." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Home,
});

const wrap = "mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-10";

function Home() {
  const rooms = Object.values(useRooms());
  const live = rooms.filter((r) => r.status === "live");
  const ending = [...live].sort((a, b) => a.endsAt - b.endsAt).slice(0, 4);

  return (
    <>
      {/* HERO */}
      <section className="relative -mt-16 overflow-hidden bg-hero pt-16">
        <div className={`${wrap} grid items-center gap-12 py-16 lg:grid-cols-[1.05fr_1fr] lg:py-24`}>
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-700">
            <p className="mb-6 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium text-muted-foreground">
              <span className="size-1.5 rounded-full bg-live animate-live" /> {live.length} auctions live right now
            </p>
            <h1 className="font-display text-[clamp(3rem,7vw,6.5rem)] leading-[0.95]">
              Extraordinary Finds.
              <br />
              <span className="italic text-gold-gradient">Unmatched</span> Possibilities.
            </h1>
            <p className="mt-6 max-w-lg text-lg text-muted-foreground">Discover, bid, and win across the world's most exciting online auctions.</p>
            <div className="mt-9 flex flex-wrap gap-3">
              <Link to="/live" className="inline-flex h-13 items-center gap-2 rounded-full bg-primary px-7 py-4 font-semibold text-primary-foreground transition hover:shadow-gold">Explore Live Auctions <ArrowRight className="size-4" /></Link>
              <Link to="/how-it-works" className="inline-flex h-13 items-center rounded-full border px-7 py-4 font-semibold hover:bg-accent">How It Works</Link>
            </div>
          </div>
          <div className="relative h-[440px] sm:h-[540px]">
            <img src={images.car} alt="Grand tourer coupé" width={1280} height={776} className="absolute left-0 top-[18%] w-[78%] rounded-3xl border object-cover shadow-card" />
            <img src={images.watch} alt="Steel diver watch" loading="lazy" className="absolute right-0 top-0 w-[40%] animate-float rounded-3xl border object-cover shadow-card" />
            <img src={images.house} alt="Modern villa" loading="lazy" className="absolute bottom-0 right-[4%] w-[46%] rounded-3xl border object-cover shadow-card" />
            <img src={images.jewelry} alt="Diamond necklace" loading="lazy" className="absolute bottom-[4%] left-[6%] w-[26%] animate-float rounded-2xl border object-cover shadow-card [animation-delay:1.5s]" />
            <img src={images.art} alt="Abstract painting" loading="lazy" className="absolute right-[38%] top-[2%] hidden w-[20%] rounded-2xl border object-cover shadow-card sm:block" />
          </div>
        </div>
        <div className={`${wrap} pb-16`}>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border bg-border md:grid-cols-4">
            {[["12,500+", "Active Auctions"], ["150K+", "Registered Bidders"], ["45+", "Countries"], ["$250M+", "Auction Volume"]].map(([n, l]) => (
              <div key={l} className="bg-background p-6">
                <p className="font-display text-4xl sm:text-5xl">{n}</p>
                <p className="mt-1 text-sm text-muted-foreground">{l}</p>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Illustrative demo figures, not verified platform data.</p>
        </div>
      </section>

      {/* LIVE */}
      <section className={`${wrap} py-16`}>
        <SectionHeading eyebrow="Happening now" title="Live Auctions" action={<Link to="/live" className="inline-flex items-center gap-1 text-sm font-semibold text-primary">View all <ArrowRight className="size-4" /></Link>} />
        <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
          {live.slice(0, 8).map((r) => <AuctionCard key={r.id} room={r} />)}
        </div>
      </section>

      {/* CATEGORIES */}
      <section className={`${wrap} py-16`}>
        <SectionHeading eyebrow="Browse" title="Popular Categories" />
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {categories.map((c, i) => (
            <Link key={c.slug} to="/explore" search={{ category: c.name }} className={`group relative overflow-hidden rounded-2xl border ${i === 0 ? "md:col-span-2 md:row-span-2" : ""}`}>
              <img src={c.image} alt={c.name} loading="lazy" className="aspect-square h-full w-full object-cover transition duration-700 group-hover:scale-105" />
              <div className="absolute inset-0 bg-fade" />
              <div className="absolute inset-x-0 bottom-0 p-5">
                <p className={`font-display ${i === 0 ? "text-4xl" : "text-2xl"}`}>{c.name}</p>
                <p className="text-sm text-muted-foreground">{c.count.toLocaleString()} lots</p>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* ENDING SOON */}
      <section className="border-y bg-surface py-16">
        <div className={wrap}>
          <SectionHeading eyebrow="Final moments" title="Ending Soon" />
          <div className="grid gap-4 md:grid-cols-2">
            {ending.map((r) => (
              <Link key={r.id} to="/room/$id" params={{ id: r.id }} className="group flex items-center gap-4 rounded-2xl border bg-card p-3 transition hover:border-primary/40">
                <img src={r.images[0]} alt="" loading="lazy" className="size-24 rounded-xl object-cover sm:size-28" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs uppercase tracking-wider text-muted-foreground">{r.category}</p>
                  <p className="truncate text-lg font-semibold">{r.title}</p>
                  <p className="text-sm text-muted-foreground">Current <span className="font-bold text-foreground tabular">${r.currentBid.toLocaleString()}</span></p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-muted-foreground">Ends in</p>
                  <Countdown room={r} className="font-display text-3xl text-live" />
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* COLLECTIONS */}
      <section className={`${wrap} py-16`}>
        <SectionHeading eyebrow="Curated" title="Featured Collections" />
        <div className="no-scrollbar -mx-4 flex snap-x gap-4 overflow-x-auto px-4 pb-2">
          {collections.map((c) => (
            <Link key={c.name} to="/explore" className="group relative w-72 shrink-0 snap-start overflow-hidden rounded-3xl border sm:w-80">
              <img src={c.image} alt={c.name} loading="lazy" className="aspect-[3/4] w-full object-cover transition duration-700 group-hover:scale-105" />
              <div className="absolute inset-0 bg-fade" />
              <div className="absolute inset-x-0 bottom-0 p-6">
                <p className="font-display text-3xl">{c.name}</p>
                <p className="mt-1 text-sm text-muted-foreground">{c.blurb}</p>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* HOW */}
      <section className={`${wrap} py-16`}>
        <SectionHeading eyebrow="Simple by design" title="How It Works" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            [Search, "Discover", "Browse thousands of curated lots across every category."],
            [UserCheck, "Register & Verify", "Create an account and confirm your identity once."],
            [Gavel, "Place Your Bid", "Join live rooms and bid in real time with confidence."],
            [Trophy, "Win & Checkout", "Pay securely and arrange shipping or pickup."],
          ].map(([Icon, t, d], i) => {
            const I = Icon as typeof Search;
            return (
              <div key={t as string} className="rounded-2xl border bg-card p-6">
                <div className="flex items-center justify-between"><I className="size-6 text-primary" /><span className="font-display text-4xl text-muted-foreground/40">0{i + 1}</span></div>
                <p className="mt-6 text-lg font-semibold">{t as string}</p>
                <p className="mt-2 text-sm text-muted-foreground">{d as string}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* TRUST */}
      <section className={`${wrap} py-8`}>
        <div className="grid gap-px overflow-hidden rounded-2xl border bg-border sm:grid-cols-2 lg:grid-cols-4">
          {[[BadgeCheck, "Verified Sellers"], [Lock, "Secure Transactions"], [Scale, "Transparent Bidding"], [ShieldCheck, "Bidder Protection"]].map(([Icon, t]) => {
            const I = Icon as typeof Lock;
            return <div key={t as string} className="flex items-center gap-3 bg-background p-6"><I className="size-5 text-primary" /><span className="font-semibold">{t as string}</span></div>;
          })}
        </div>
      </section>

      {/* AI */}
      <section className={`${wrap} py-16`}>
        <div className="grid items-center gap-10 overflow-hidden rounded-3xl border bg-surface p-6 sm:p-10 lg:grid-cols-2 lg:p-16">
          <div>
            <p className="mb-3 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-primary"><Sparkles className="size-4" /> AUCTRA AI</p>
            <h2 className="font-display text-5xl leading-tight sm:text-6xl">Your Personal Auction Expert.</h2>
            <p className="mt-5 max-w-md text-muted-foreground">Discover products, compare listings, understand auction fees, and navigate bidding — in plain language. Informational only; AI never bids for you.</p>
            <div className="mt-6 flex items-center gap-4 text-sm text-muted-foreground"><Eye className="size-4" /> Try it — it's live on this page.</div>
          </div>
          <div className="h-[460px] overflow-hidden rounded-2xl border bg-popover shadow-card">
            <AiChat compact />
          </div>
        </div>
      </section>
    </>
  );
}
