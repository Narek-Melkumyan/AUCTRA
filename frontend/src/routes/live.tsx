import { createFileRoute } from "@tanstack/react-router";
import { IS_API_MODE, useRooms } from "@/lib/auction-store";
import { ApiLive } from "@/components/explore/ApiLive";
import { AuctionCard, SectionHeading } from "@/components/auction/bits";

export const Route = createFileRoute("/live")({
  head: () => ({
    meta: [
      { title: "Live Now — AUCTRA" },
      {
        name: "description",
        content: "Every auction room open right now, each with its own countdown and bidding.",
      },
      { property: "og:title", content: "Live Now — AUCTRA" },
      { property: "og:description", content: "Join live auction rooms and bid in real time." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: () => (IS_API_MODE ? <ApiLive /> : <Live />),
});

function Live() {
  const rooms = Object.values(useRooms());
  const live = rooms.filter((r) => r.status === "live").sort((a, b) => a.endsAt - b.endsAt);
  const upcoming = rooms.filter((r) => r.status === "upcoming");
  const ended = rooms.filter((r) => r.status === "ended");
  return (
    <div className="mx-auto max-w-[1440px] px-4 py-12 sm:px-6 lg:px-10">
      <h1 className="font-display text-5xl sm:text-7xl">
        Live <span className="italic text-gold-gradient">Now</span>
      </h1>
      <p className="mt-3 max-w-xl text-muted-foreground">
        Each room runs independently — its own clock, bids, chat and participants.
      </p>
      <div className="mt-12 grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
        {live.map((r) => (
          <AuctionCard key={r.id} room={r} />
        ))}
      </div>
      {upcoming.length > 0 && (
        <div className="mt-20">
          <SectionHeading eyebrow="Scheduled" title="Starting Later" />
          <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
            {upcoming.map((r) => (
              <AuctionCard key={r.id} room={r} />
            ))}
          </div>
        </div>
      )}
      {ended.length > 0 && (
        <div className="mt-20">
          <SectionHeading eyebrow="Results" title="Recently Closed" />
          <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
            {ended.map((r) => (
              <AuctionCard key={r.id} room={r} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
