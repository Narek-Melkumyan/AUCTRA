import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { categories, collections, images } from "@/lib/auctions";
import { useRooms } from "@/lib/auction-store";
import { useNavCategories } from "@/lib/api/categories";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { CategoryThumb } from "@/components/explore/CategoryThumb";
import { AuctionCard, Countdown, SectionHeading } from "@/components/auction/bits";
import { AiChat } from "@/components/ai/AiChat";
import { AssistantChat } from "@/components/ai/AssistantChat";
import { IS_API_MODE } from "@/lib/auction-store";
import { AuctionImage } from "@/components/auction/AuctionImage";
import { photoFromUrl, photoOf } from "@/lib/media";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "AUCTRA | Live Online Auctions" },
      {
        name: "description",
        content:
          "Live online auctions for cars, luxury watches, real estate, jewelry, art and collectibles.",
      },
      { property: "og:title", content: "AUCTRA — Extraordinary Finds. Unmatched Possibilities." },
      {
        property: "og:title",
        content: "AUCTRA | Live Online Auctions",
      },
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
  // Feature a real live lot (a car when one is live) with its own photo and caption.
  const feature =
    live.find((r) => r.category === "Cars & Vehicles" || r.categorySlug === "cars") ?? live[0];
  const navCats = useNavCategories();
  // API mode: the real number of open rooms (the store only holds the first page).
  const liveCount = useQuery({
    queryKey: ["live-count"],
    queryFn: () => api<{ total: number }>("/auctions?phase=live&limit=1"),
    enabled: IS_API_MODE,
    refetchInterval: 60_000,
  });
  const liveTotal = IS_API_MODE ? liveCount.data?.total : undefined;
  const side = live.filter((r) => r.id !== feature?.id && photoOf(r)).slice(0, 2);

  return (
    <>
      {/* HERO */}
      <section className="border-b">
        <div className={`${wrap} grid gap-10 py-12 lg:grid-cols-12 lg:gap-12 lg:py-20`}>
          <div className="flex flex-col justify-center lg:col-span-5">
            <p className="mb-5 inline-flex items-center gap-2 text-xs text-muted-foreground">
              <span className="size-1.5 rounded-full bg-live" />{" "}
              {(liveTotal ?? live.length).toLocaleString()} auctions live now
            </p>
            <h1 className="text-[clamp(2.25rem,4.4vw,3.5rem)] font-medium leading-[1.05] tracking-[-0.035em]">
              Extraordinary finds.
              <br />
              <span className="text-muted-foreground">Unmatched possibilities.</span>
            </h1>
            <p className="mt-5 max-w-md text-base text-muted-foreground">
              Bid on authenticated cars, watches, property, jewelry and art — from verified sellers,
              in real time.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-5">
              <Link
                to="/live"
                className="inline-flex h-11 items-center gap-2 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition hover:opacity-90"
              >
                Explore live auctions <ArrowRight className="size-4" />
              </Link>
              <Link
                to="/how-it-works"
                className="text-sm font-medium underline-offset-4 hover:underline"
              >
                How it works
              </Link>
            </div>
          </div>
          <div className="grid grid-cols-6 grid-rows-2 gap-3 lg:col-span-7">
            <figure className="relative col-span-6 row-span-2 overflow-hidden rounded-lg bg-muted sm:col-span-4">
              <AuctionImage
                photo={feature ? photoOf(feature) : photoFromUrl(images.car)}
                size="full"
                sizes="(min-width: 1024px) 45vw, 100vw"
                eager
                alt={feature?.title ?? "Grand tourer coupé"}
                className="h-full min-h-[280px] w-full object-cover"
              />
              {feature && (
                <Link
                  to="/room/$id"
                  params={{ id: feature.id }}
                  className="absolute inset-x-3 bottom-3 flex items-center justify-between gap-3 rounded-md bg-background/95 px-3 py-2.5 text-sm"
                >
                  <span className="min-w-0 truncate font-medium">{feature.title}</span>
                  <span className="shrink-0 tabular text-muted-foreground">{`$${feature.currentBid.toLocaleString()}`}</span>
                </Link>
              )}
            </figure>
            {[0, 1].map((i) => {
              // API mode: the next live lots with their own photos; otherwise decorative art.
              const lot = side[i];
              return lot ? (
                <Link
                  key={lot.id}
                  to="/room/$id"
                  params={{ id: lot.id }}
                  className="col-span-2 hidden overflow-hidden rounded-lg sm:block"
                  aria-label={lot.title}
                >
                  <AuctionImage
                    photo={photoOf(lot)}
                    size="card"
                    sizes="(min-width: 1024px) 20vw, 33vw"
                    alt={lot.title}
                    className="h-full w-full object-cover transition hover:opacity-90"
                  />
                </Link>
              ) : (
                <img
                  key={i}
                  src={i === 0 ? images.watch : images.art}
                  alt=""
                  loading="lazy"
                  className="col-span-2 hidden h-full w-full rounded-lg object-cover sm:block"
                />
              );
            })}
          </div>
        </div>
      </section>

      {/* CATEGORIES */}
      <section className={`${wrap} pt-10`}>
        <nav aria-label="Categories" className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
          {navCats
            .filter((c) => c.count > 0)
            .map((c) => (
              <Link
                key={c.key}
                to="/explore"
                search={{ category: c.param }}
                className="group flex shrink-0 items-center gap-3 rounded-lg border bg-card py-1.5 pl-1.5 pr-4 transition hover:bg-accent"
              >
                <CategoryThumb name={c.name} image={c.image} className="size-9" />
                <span className="text-sm font-medium">{c.name}</span>
                <span className="text-xs text-muted-foreground tabular">
                  {c.count.toLocaleString()}
                </span>
              </Link>
            ))}
        </nav>
      </section>

      {/* LIVE */}
      <section className={`${wrap} py-14`}>
        <SectionHeading
          eyebrow="Happening now"
          title="Live auctions"
          action={
            <Link
              to="/live"
              className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              View all <ArrowRight className="size-4" />
            </Link>
          }
        />
        <div className="grid gap-x-6 gap-y-10 sm:grid-cols-2 xl:grid-cols-4">
          {live.slice(0, 8).map((r) => (
            <AuctionCard key={r.id} room={r} />
          ))}
        </div>
      </section>

      {/* ENDING SOON + ASSISTANT */}
      <section className={`${wrap} grid gap-12 pb-16 lg:grid-cols-12`}>
        <div className="lg:col-span-7">
          <SectionHeading eyebrow="Final moments" title="Ending soon" />
          <ul className="divide-y">
            {ending.map((r) => (
              <li key={r.id}>
                <Link
                  to="/room/$id"
                  params={{ id: r.id }}
                  className="group flex items-center gap-4 py-3"
                >
                  <AuctionImage
                    photo={photoOf(r)}
                    size="thumb"
                    sizes="56px"
                    alt=""
                    className="size-14 rounded-md object-cover"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium group-hover:underline underline-offset-4">
                      {r.title}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {r.category} · {r.location}
                    </p>
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
            {IS_API_MODE ? <AssistantChat compact /> : <AiChat compact />}
          </div>
        </div>
      </section>

      {/* COLLECTIONS */}
      <section className="border-t bg-surface py-14">
        <div className={wrap}>
          <SectionHeading eyebrow="Curated" title="Featured collections" />
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {collections.slice(0, 4).map((c) => (
              <Link
                key={c.name}
                to="/explore"
                search={{ category: IS_API_MODE ? c.slug : c.category }}
                className="group"
              >
                <img
                  src={c.image}
                  alt={c.name}
                  loading="lazy"
                  className="aspect-[4/5] w-full rounded-lg object-cover transition group-hover:opacity-90"
                />
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
            <p className="mt-3 text-sm text-muted-foreground">
              Every seller is verified and every bid is recorded in the public history of the lot.
            </p>
            <Link
              to="/how-it-works"
              className="mt-4 inline-flex items-center gap-1 text-sm font-medium hover:underline underline-offset-4"
            >
              Read the full process <ArrowRight className="size-4" />
            </Link>
          </div>
          <ol className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-2 lg:col-span-8">
            {[
              ["Discover", "Browse curated lots with condition reports and seller history."],
              ["Register", "Create an account and verify your identity once."],
              ["Bid", "Join a live room and bid in clear, fixed increments."],
              ["Settle", "Pay securely and arrange insured shipping or pickup."],
            ].map(([t, d], i) => (
              <li key={t} className="bg-card p-5">
                <p className="text-xs text-muted-foreground tabular">
                  {String(i + 1).padStart(2, "0")}
                </p>
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
