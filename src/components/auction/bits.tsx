import { Link } from "@tanstack/react-router";
import { Eye, Gavel, Heart, Timer, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmt } from "@/lib/auctions";
import { toggleWatch, useAuctionStore, type RoomState } from "@/lib/auction-store";
import { formatRemaining, useNow } from "@/lib/use-now";

export function LiveBadge({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full bg-live px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-live-foreground", className)}>
      <span className="size-1.5 rounded-full bg-live-foreground animate-live" /> Live
    </span>
  );
}

export function StatusBadge({ room }: { room: RoomState }) {
  if (room.status === "live") return <LiveBadge />;
  return (
    <span className="rounded-full glass px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-foreground">
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
    <span className={cn("tabular", room.status === "live" && ms < 10000 && "animate-urgent font-bold", className)}>
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
      className={cn("grid size-9 place-items-center rounded-full glass transition hover:scale-105", className)}
    >
      <Heart className={cn("size-4", watched ? "fill-live text-live" : "text-foreground")} />
    </button>
  );
}

export function AuctionCard({ room, layout = "grid" }: { room: RoomState; layout?: "grid" | "list" }) {
  const list = layout === "list";
  return (
    <article className={cn("group relative overflow-hidden rounded-2xl border bg-card shadow-card transition duration-300 hover:-translate-y-1 hover:border-primary/40", list && "sm:flex")}>
      <Link to="/item/$id" params={{ id: room.id }} className={cn("relative block overflow-hidden", list ? "sm:w-72 sm:shrink-0" : "")}>
        <img src={room.images[0]} alt={room.title} loading="lazy" width={800} height={600} className="aspect-[4/3] h-full w-full object-cover transition duration-700 group-hover:scale-105" />
        <div className="absolute inset-x-0 top-0 flex items-center justify-between p-3">
          <StatusBadge room={room} />
          <WatchButton id={room.id} />
        </div>
        <div className="absolute bottom-3 left-3 inline-flex items-center gap-1.5 rounded-full glass px-2.5 py-1 text-xs font-semibold">
          <Timer className="size-3.5 text-primary" /> <Countdown room={room} />
        </div>
      </Link>
      <div className="flex flex-1 flex-col gap-3 p-5">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="uppercase tracking-wider">{room.category}</span>
          {room.verified && <ShieldCheck className="size-3.5 text-primary" />}
        </div>
        <Link to="/item/$id" params={{ id: room.id }} className="line-clamp-2 text-lg font-semibold leading-snug hover:text-primary">
          {room.title}
        </Link>
        <div className="mt-auto flex items-end justify-between gap-3">
          <div>
            <p className="text-xs text-muted-foreground">{room.status === "upcoming" ? "Starting bid" : "Current bid"}</p>
            <p key={room.currentBid} className="animate-bump text-2xl font-bold tabular">{fmt(room.currentBid)}</p>
            {room.buyNow && <p className="text-xs text-muted-foreground">Buy now {fmt(room.buyNow)}</p>}
          </div>
          <div className="flex flex-col items-end gap-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1"><Gavel className="size-3.5" />{room.bids.length} bids</span>
            <span className="inline-flex items-center gap-1"><Eye className="size-3.5" />{room.watchers.toLocaleString()} watching</span>
          </div>
        </div>
        <Link
          to="/room/$id"
          params={{ id: room.id }}
          className={cn(
            "inline-flex h-11 items-center justify-center rounded-xl text-sm font-semibold transition",
            room.status === "live" ? "bg-primary text-primary-foreground hover:shadow-gold" : "border bg-secondary text-secondary-foreground hover:bg-accent",
          )}
        >
          {room.status === "live" ? "Bid Now" : room.status === "upcoming" ? "Preview Room" : "View Results"}
        </Link>
      </div>
    </article>
  );
}

export function SectionHeading({ eyebrow, title, action }: { eyebrow?: string; title: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        {eyebrow && <p className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-primary">{eyebrow}</p>}
        <h2 className="font-display text-4xl leading-tight sm:text-5xl">{title}</h2>
      </div>
      {action}
    </div>
  );
}
