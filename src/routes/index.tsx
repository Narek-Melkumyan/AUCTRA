import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
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

const wrap = "mx-auto max-w-[1280px] px-4 sm:px-6 lg:px-8";

function Home() {
  const rooms = Object.values(useRooms());
  const live = rooms.filter((r) => r.status === "live");
  const ending = [...live].sort((a, b) => a.endsAt - b.endsAt).slice(0, 5);
  const feature = live[0];

  return (
    <>
      {/* HERO */}
      <section className="border-b">
        <div className={`${wrap} grid gap-10 py-12 lg:grid-cols-12 lg:gap-12 lg:py-20`}>
          <div className="flex flex-col justify-center lg:col-span-5">
            <p className="mb-5 inline-flex items-center gap-2 text-xs text-muted-foreground">
              <span className="size-1.5 rounded-full bg-live" /> {live.length} auctions live now
            </p>
            <h1 className="text-[clamp(2.25rem,4.4vw,3.5rem)] font-medium leading-[1.05] tracking-[-0.035em]">
              Extraordinary finds.
              <br />
              <span className="text-muted-foreground">Unmatched possibilities.</span>
            </h1>
            <p className="mt-5 max-w-md text-base text-muted-foreground">Bid on authenticated cars, watches, property, jewelry and art — from verified sellers, in real time.</p>
            <div className="mt-8 flex flex-wrap items-center gap-5">
              <Link to="/live" className="inline-flex h-11 items-center gap-2 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition hover:opacity-90">Explore live auctions <ArrowRight className="size-4" /></Link>
              <Link to="/how-it-works" className="text-sm font-medium underline-offset-4 hover:underline">How it works</Link>
            </div>
          </div>
          <div className="grid grid-cols-6 grid-rows-2 gap-3 lg:col-span-7">
            <figure className="relative col-span-6 row-span-2 overflow-hidden rounded-lg bg-muted sm:col-span-4">
              <img src={images.car} alt="Grand tourer coupé" width={1280} height={776} className="h-full min-h-[280px] w-full object-cover" />
              {feature && (
                <Link to="/room/$id" params={{ id: feature.id }} className="absolute inset-x-3 bottom-3 flex items-center justify-between gap-3 rounded-md bg-background/95 px-3 py-2.5 text-sm">
                  <span className="min-w-0 truncate font-medium">{feature.title}</span>
                  <span className="shrink-0 tabular text-muted-foreground">{`$${feature.currentBid.toLocaleString()}`}</span>
                </Link>
              )}
            </figure>
            <img src={images.watch} alt="Steel diver watch" loading="lazy" className="col-span-2 hidden h-full w-full rounded-lg object-cover sm:block" />
            <img src={images.art} alt="Abstract painting" loading="lazy" className="col-span-2 hidden h-full w-full rounded-lg object-cover sm:block" />
          </div>
        </div>
      </section>

      {/* CATEGORIES */}
      <section className={`${wrap} pt-10`}>
        <nav aria-label="Categories" className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
          {categories.map((c) => (
            <Link key={c.slug} to="/explore" search={{ category: c.name }} className="group flex shrink-0 items-center gap-3 rounded-lg border bg-card py-1.5 pl-1.5 pr-4 transition hover:bg-accent">
              <img src={c.image} alt="" loading="lazy" className="size-9 rounded-md object-cover" />
              <span className="text-sm font-medium">{c.name}</span>
              <span className="text-xs text-muted-foreground tabular">{c.count.toLocaleString()}</span>
            </Link>
          ))}
        </nav>
      </section>

      {/* LIVE */}
      <section className={`${wrap} py-14`}>
        <SectionHeading eyebrow="Happening now" title="Live auctions" action={<Link to="/live" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">View all <ArrowRight className="size-4" /></Link>} />
        <div className="grid gap-x-6 gap-y-10 sm:grid-cols-2 xl:grid-cols-4">
          {live.slice(0, 8).map((r) => <AuctionCard key={r.id} room={r} />)}
        </div>
      </section>

      {/* ENDING SOON + ASSISTANT */}
      <section className={`${wrap} grid gap-12 pb-16 lg:grid-cols-12`}>
        <div className="lg:col-span-7">
          <SectionHeading eyebrow="Final moments" title="Ending soon" />
          <ul className="divide-y">
            {ending.map((r) => (
              <li key={r.id}>
                <Link to="/room/$id" params={{ id: r.id }} className="group flex items-center gap-4 py-3">
                  <img src={r.images[0]} alt="" loading="lazy" className="size-14 rounded-md object-cover" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium group-hover:underline underline-offset-4">{r.title}</p>
                    <p className="text-xs text-muted-foreground">{r.category} · {r.location}</p>
                  </div>
                  <p className="hidden w-28 text-right text-sm tabular sm:block">{`$${r.currentBid.toLocaleString()}`}</p>
                  <Countdown room={r} className="w-20 text-right text-sm text-live" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div className="lg:col-span-5">
          <SectionHeading eyebrow="Questions about a lot?" title="Ask the AUCTRA assistant" />
          <div className="h-[420px] overflow-hidden rounded-lg border bg-card">
            <AiChat compact />
          </div>
        </div>
      </section>

      {/* COLLECTIONS */}
      <section className="border-t bg-surface py-14">
        <div className={wrap}>
          <SectionHeading eyebrow="Curated" title="Featured collections" />
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {collections.slice(0, 4).map((c) => (
              <Link key={c.name} to="/explore" className="group">
                <img src={c.image} alt={c.name} loading="lazy" className="aspect-[4/5] w-full rounded-lg object-cover transition group-hover:opacity-90" />
                <p className="mt-3 text-sm font-medium">{c.name}</p>
                <p className="mt-0.5 text-sm text-muted-foreground">{c.blurb}</p>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* PROCESS */}
      <section className={`${wrap} py-14`}>
        <div className="grid gap-10 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <h2 className="text-2xl font-medium tracking-tight">Bidding, made transparent.</h2>
            <p className="mt-3 text-sm text-muted-foreground">Every seller is verified and every bid is recorded in the public history of the lot.</p>
            <Link to="/how-it-works" className="mt-4 inline-flex items-center gap-1 text-sm font-medium hover:underline underline-offset-4">Read the full process <ArrowRight className="size-4" /></Link>
          </div>
          <ol className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-2 lg:col-span-8">
            {[
              ["Discover", "Browse curated lots with condition reports and seller history."],
              ["Register", "Create an account and verify your identity once."],
              ["Bid", "Join a live room and bid in clear, fixed increments."],
              ["Settle", "Pay securely and arrange insured shipping or pickup."],
            ].map(([t, d], i) => (
              <li key={t} className="bg-card p-5">
                <p className="text-xs text-muted-foreground tabular">{String(i + 1).padStart(2, "0")}</p>
                <p className="mt-3 text-sm font-medium">{t}</p>
                <p className="mt-1 text-sm text-muted-foreground">{d}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>
    </>
  );
}
