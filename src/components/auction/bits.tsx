import { Link } from "@tanstack/react-router";
import { Eye, Gavel, Heart, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmt } from "@/lib/auctions";
import { toggleWatch, useAuctionStore, type RoomState } from "@/lib/auction-store";
import { formatRemaining, useNow } from "@/lib/use-now";

export function LiveBadge({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-md bg-background/90 px-2 py-1 text-[11px] font-medium uppercase tracking-wider text-live", className)}>
      <span className="size-1.5 rounded-full bg-live animate-live" /> Live
    </span>
  );
}

export function StatusBadge({ room }: { room: RoomState }) {
  if (room.status === "live") return <LiveBadge />;
  return (
    <span className="rounded-md bg-background/90 px-2 py-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
      {room.status === "upcoming" ? "Upcoming" : "Closed"}
    </span>
  );
}

export function Countdown({ room, className }: { room: RoomState; className?: string }) {
  const now = useNow();
  if (now === null) return <span className={cn("tabular", className)}>--:--</span>;
  if (room.status === "ended") return <span className={className}>Closed</span>;
  const target = room.status === "upcoming" ? room.startsAt : room.endsAt;
  const ms = target - now;
  return (
    <span className={cn("tabular", room.status === "live" && ms < 10000 && "animate-urgent font-semibold", className)}>
      {room.status === "upcoming" && "Starts in "}
      {formatRemaining(ms)}
    </span>
  );
}

export function WatchButton({ id, className }: { id: string; className?: string }) {
  const watched = useAuctionStore((s) => s.watchlist.includes(id));
  return (
    <button
      aria-label={watched ? "Remove from watchlist" : "Add to watchlist"}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleWatch(id);
      }}
      className={cn("grid size-8 place-items-center rounded-md bg-background/90 transition hover:bg-background", className)}
    >
      <Heart className={cn("size-4", watched ? "fill-live text-live" : "text-foreground")} />
    </button>
  );
}

export function AuctionCard({ room, layout = "grid" }: { room: RoomState; layout?: "grid" | "list" }) {
  const list = layout === "list";
  return (
    <article className={cn("group relative flex flex-col", list && "gap-4 rounded-lg border bg-card p-3 sm:flex-row")}>
      <Link to="/item/$id" params={{ id: room.id }} className={cn("relative block overflow-hidden rounded-lg bg-muted", list && "sm:w-64 sm:shrink-0")}>
        <img src={room.images[0]} alt={room.title} loading="lazy" width={800} height={600} className="aspect-[4/3] h-full w-full object-cover transition duration-500 group-hover:opacity-90" />
        <div className="absolute inset-x-0 top-0 flex items-center justify-between p-2.5">
          {room.status === "live" ? <LiveBadge /> : <StatusBadge room={room} />}
          <WatchButton id={room.id} />
        </div>
      </Link>
      <div className={cn("flex flex-1 flex-col pt-3", list && "sm:pt-1")}>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {room.category} · {room.location}
          {room.verified && <ShieldCheck className="size-3.5 text-info" aria-label="Verified seller" />}
        </p>
        <Link to="/item/$id" params={{ id: room.id }} className="mt-1 line-clamp-1 text-[15px] font-medium leading-snug hover:underline underline-offset-4">
          {room.title}
        </Link>
        <div className="mt-3 flex items-end justify-between gap-3 border-t pt-3">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{room.status === "upcoming" ? "Starting bid" : "Current bid"}</p>
            <p key={room.currentBid} className="animate-bump text-base font-medium tabular">{fmt(room.currentBid)}</p>
          </div>
          <div className="text-right">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{room.status === "upcoming" ? "Opens" : "Time left"}</p>
            <Countdown room={room} className="text-base font-medium" />
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1"><Gavel className="size-3.5" />{room.bids.length}</span>
            <span className="inline-flex items-center gap-1"><Eye className="size-3.5" />{room.watchers.toLocaleString()}</span>
          </span>
          <Link to="/room/$id" params={{ id: room.id }} className={cn("inline-flex h-8 items-center rounded-md px-3 text-xs font-medium transition", room.status === "live" ? "bg-primary text-primary-foreground hover:opacity-90" : "border hover:bg-accent")}>
            {room.status === "live" ? "Bid now" : room.status === "upcoming" ? "Preview" : "Results"}
          </Link>
        </div>
      </div>
    </article>
  );
}

export function SectionHeading({ eyebrow, title, action }: { eyebrow?: string; title: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b pb-4">
      <div>
        {eyebrow && <p className="mb-1 text-xs text-muted-foreground">{eyebrow}</p>}
        <h2 className="text-2xl font-medium tracking-tight">{title}</h2>
      </div>
      {action}
    </div>
  );
}
