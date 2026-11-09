import { useEffect, useRef, useState } from "react";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { ArrowLeft, ChevronDown, Gavel, MapPin, Maximize2, Pin, Send, ShieldAlert, ShieldCheck, Trophy, Users, X } from "lucide-react";
import { toast } from "sonner";
import { seedAuctions, fmtFull } from "@/lib/auctions";
import { MY_HANDLE, placeBid, sendChat, useRoom, useRooms, validateBid, type RoomState } from "@/lib/auction-store";
import { formatRemaining, useNow } from "@/lib/use-now";
import { LiveBadge, StatusBadge, WatchButton } from "@/components/auction/bits";
import { AiChat } from "@/components/ai/AiChat";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/room/$id")({
  loader: ({ params }) => {
    const a = seedAuctions.find((x) => x.id === params.id);
    if (!a) throw notFound();
    return { title: a.title };
  },
  head: ({ loaderData }) => ({
    meta: [
      { title: loaderData ? `Live Room: ${loaderData.title} — AUCTRA` : "Auction room — AUCTRA" },
      { name: "description", content: loaderData ? `Bid live on ${loaderData.title}.` : "Live auction room." },
      { property: "og:title", content: loaderData ? `Live Room: ${loaderData.title}` : "Auction room" },
      { property: "og:description", content: "Real-time bidding, chat and AI assistance." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Room,
});

function Room() {
  const { id } = Route.useParams();
  const room = useRoom(id);
  const rooms = Object.values(useRooms()).filter((r) => r.status !== "ended");
  if (!room) return null;
  return (
    <div className="mx-auto max-w-[1600px] px-0 sm:px-4 lg:px-6">
      {/* Room switcher */}
      <div className="no-scrollbar flex items-center gap-2 overflow-x-auto px-4 py-3 sm:px-0">
        <Link to="/live" className="inline-flex shrink-0 items-center gap-1 rounded-full border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> Rooms</Link>
        {rooms.map((r) => (
          <Link key={r.id} to="/room/$id" params={{ id: r.id }} className={cn("inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-sm", r.id === id ? "border-primary bg-primary/10 text-foreground" : "text-muted-foreground hover:text-foreground")}>
            {r.status === "live" && <span className="size-1.5 rounded-full bg-live" />}
            <span className="max-w-40 truncate">{r.title}</span>
          </Link>
        ))}
      </div>
      <div key={id} className="grid gap-4 pb-40 lg:grid-cols-[1fr_minmax(360px,420px)] lg:pb-8 2xl:grid-cols-[1fr_440px_400px]">
        <ItemPanel room={room} />
        <BidPanel room={room} />
        <div className="lg:col-span-2 2xl:col-span-1"><ActivityPanel room={room} /></div>
      </div>
    </div>
  );
}

function ItemPanel({ room }: { room: RoomState }) {
  const [img, setImg] = useState(0);
  const [zoom, setZoom] = useState(false);
  const [open, setOpen] = useState(false);
  return (
    <section className="min-w-0 space-y-4">
      <div className="relative overflow-hidden bg-card sm:rounded-2xl sm:border">
        <img src={room.images[img]} alt={room.title} className="aspect-[4/3] w-full object-cover" />
        <div className="absolute left-3 top-3 flex gap-2"><StatusBadge room={room} /></div>
        <div className="absolute right-3 top-3 flex gap-2">
          <WatchButton id={room.id} />
          <button onClick={() => setZoom(true)} aria-label="Zoom image" className="grid size-9 place-items-center rounded-full glass"><Maximize2 className="size-4" /></button>
        </div>
      </div>
      {room.images.length > 1 && (
        <div className="flex gap-2 px-4 sm:px-0">
          {room.images.map((s, i) => <button key={i} onClick={() => setImg(i)} className={cn("overflow-hidden rounded-lg border-2", img === i ? "border-primary" : "border-transparent opacity-60")}><img src={s} alt="" className="size-16 object-cover" /></button>)}
        </div>
      )}
      <div className="px-4 sm:px-0">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">{room.lot} · {room.category}</p>
        <h1 className="mt-1 font-display text-3xl leading-tight sm:text-4xl">{room.title}</h1>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1"><MapPin className="size-4" />{room.location}</span>
          <span>Condition: <span className="text-foreground">{room.condition}</span></span>
          <span className="inline-flex items-center gap-1">{room.verified ? <ShieldCheck className="size-4 text-primary" /> : <ShieldAlert className="size-4" />}{room.seller}{room.verified ? " · Verified" : " · Unverified"}</span>
        </div>
        <button onClick={() => setOpen(!open)} className="mt-4 flex w-full items-center justify-between rounded-xl border px-4 py-3 text-sm font-semibold lg:hidden">Item details <ChevronDown className={cn("size-4 transition", open && "rotate-180")} /></button>
        <div className={cn("mt-4 space-y-5 lg:block", !open && "hidden")}>
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border text-sm">
            {room.specs.map(([k, v]) => <div key={k} className="bg-card p-3"><dt className="text-xs text-muted-foreground">{k}</dt><dd className="font-medium">{v}</dd></div>)}
          </dl>
          <Info title="Description">{room.description}</Info>
          <Info title="Inspection notes">{room.inspection}</Info>
          <Info title="Shipping & pickup">{room.shipping}</Info>
        </div>
      </div>
      <Dialog open={zoom} onOpenChange={setZoom}>
        <DialogContent className="max-w-5xl p-0"><DialogTitle className="sr-only">{room.title}</DialogTitle><img src={room.images[img]} alt={room.title} className="w-full rounded-lg" /></DialogContent>
      </Dialog>
    </section>
  );
}
function Info({ title, children }: { title: string; children: React.ReactNode }) {
  return <div><p className="mb-1 text-sm font-semibold">{title}</p><p className="text-sm leading-relaxed text-muted-foreground">{children}</p></div>;
}

function BidPanel({ room }: { room: RoomState }) {
  const now = useNow(250);
  const min = room.currentBid + room.increment;
  const [custom, setCustom] = useState("");
  const [confirm, setConfirm] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const top = room.bids[0];
  const myStatus = top?.mine ? "winning" : room.bids.some((b) => b.mine) ? "outbid" : "none";
  const remaining = now === null ? null : (room.status === "upcoming" ? room.startsAt : room.endsAt) - now;
  const urgent = room.status === "live" && remaining !== null && remaining < 10000;

  const prevStatus = useRef(myStatus);
  useEffect(() => {
    if (prevStatus.current === "winning" && myStatus === "outbid") toast.error("You've been outbid", { description: `New high bid ${fmtFull(room.currentBid)}` });
    prevStatus.current = myStatus;
  }, [myStatus, room.currentBid]);

  const request = (amount: number) => {
    const err = validateBid(room, amount);
    setError(err);
    if (!err) setConfirm(amount);
  };
  const submit = () => {
    if (confirm === null) return;
    const err = placeBid(room.id, confirm);
    if (err) { setError(err); toast.error(err); } else { toast.success(`Bid placed: ${fmtFull(confirm)}`); setCustom(""); }
    setConfirm(null);
  };

  const quick = [min, min + room.increment, min + room.increment * 4];
  const disabled = room.status !== "live";

  return (
    <section className={cn("relative h-fit overflow-hidden border-y bg-card p-5 transition-colors sm:rounded-2xl sm:border lg:sticky lg:top-20", myStatus === "winning" && "border-success/60", urgent && "border-live/70")}>
      <div className="flex items-center justify-between">
        {room.status === "live" ? <span className="flex items-center gap-2"><LiveBadge /><span className="text-xs text-muted-foreground">Session open</span></span> : <StatusBadge room={room} />}
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Users className="size-3.5" />{room.viewers} watching</span>
      </div>
      <div className="mt-6 text-center">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">{room.status === "upcoming" ? "Starts in" : room.status === "ended" ? "Auction" : "Time remaining"}</p>
        <p className={cn("font-display text-6xl tabular sm:text-7xl", urgent && "animate-urgent")}>{room.status === "ended" ? "Closed" : remaining === null ? "--:--" : formatRemaining(remaining)}</p>
      </div>
      <div className="mt-6 rounded-2xl bg-secondary p-5 text-center">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">Current highest bid</p>
        <p key={room.currentBid} className="animate-bump text-5xl font-extrabold tabular">{fmtFull(room.currentBid)}</p>
        <div className="mt-3 flex justify-center gap-4 text-xs text-muted-foreground">
          <span>{room.bids.length} bids</span>
          <span>Increment {fmtFull(room.increment)}</span>
          <span className={room.reserve === "met" ? "text-success" : room.reserve === "not-met" ? "text-live" : ""}>{room.reserve === "met" ? "Reserve met" : room.reserve === "not-met" ? "Reserve not met" : "No reserve"}</span>
        </div>
      </div>
      {myStatus !== "none" && room.status === "live" && (
        <div key={myStatus} className={cn("mt-4 animate-in fade-in zoom-in-95 rounded-xl px-4 py-3 text-center text-sm font-semibold", myStatus === "winning" ? "bg-success/15 text-success" : "bg-live/15 text-live")}>
          {myStatus === "winning" ? "You're the highest bidder" : "You've been outbid — bid again to lead"}
        </div>
      )}
      <div className="mt-5 grid grid-cols-3 gap-2">
        {quick.map((q) => <button key={q} disabled={disabled} onClick={() => request(q)} className="rounded-xl border py-2.5 text-sm font-semibold tabular transition hover:border-primary disabled:opacity-40">{fmtFull(q)}</button>)}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); request(Number(custom)); }} className="mt-2 flex gap-2">
        <div className="flex h-12 flex-1 items-center rounded-xl border bg-background px-3 focus-within:border-primary">
          <span className="text-muted-foreground">$</span>
          <input disabled={disabled} inputMode="numeric" value={custom} onChange={(e) => setCustom(e.target.value.replace(/\D/g, ""))} placeholder={min.toLocaleString()} aria-label="Custom bid amount" className="h-full min-w-0 flex-1 bg-transparent px-1 tabular outline-none" />
        </div>
        <button disabled={disabled || !custom} className="rounded-xl border px-4 text-sm font-semibold disabled:opacity-40">Set</button>
      </form>
      {error && <p className="mt-2 text-sm text-live">{error}</p>}
      <p className="mt-3 text-center text-xs text-muted-foreground">Minimum next bid <span className="font-semibold text-foreground">{fmtFull(min)}</span></p>

      {/* Desktop main button */}
      <button disabled={disabled} onClick={() => request(min)} className="mt-4 hidden h-14 w-full items-center justify-center gap-2 rounded-2xl bg-primary text-lg font-bold text-primary-foreground transition hover:shadow-gold disabled:opacity-40 lg:flex">
        <Gavel className="size-5" /> BID NOW · {fmtFull(min)}
      </button>

      {/* Mobile sticky bar */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t glass p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:hidden">
        <div className="flex items-center gap-3">
          <div className="min-w-0">
            <p key={room.currentBid} className="animate-bump text-xl font-extrabold tabular">{fmtFull(room.currentBid)}</p>
            <p className={cn("text-xs tabular text-muted-foreground", urgent && "animate-urgent")}>{room.status === "ended" ? "Closed" : remaining === null ? "--:--" : formatRemaining(remaining)} · {myStatus === "winning" ? "Leading" : myStatus === "outbid" ? "Outbid" : `${room.bids.length} bids`}</p>
          </div>
          <button disabled={disabled} onClick={() => request(min)} className="ml-auto h-12 flex-1 rounded-xl bg-primary px-4 font-bold text-primary-foreground disabled:opacity-40">Bid {fmtFull(min)}</button>
        </div>
      </div>

      {room.status === "ended" && (
        <div className="absolute inset-0 grid place-items-center bg-card/90 p-6 text-center backdrop-blur-sm animate-in fade-in">
          <div>
            <Trophy className={cn("mx-auto size-10", top?.mine ? "text-success" : "text-primary")} />
            <p className="mt-3 font-display text-4xl">{top?.mine ? "You won!" : "Auction closed"}</p>
            <p className="mt-2 text-muted-foreground">{top ? <>Winning bid <span className="font-bold text-foreground">{fmtFull(room.currentBid)}</span> by {top.mine ? "you" : top.user}</> : "No bids were placed."}</p>
            {room.reserve === "not-met" && <p className="mt-1 text-sm text-live">Reserve not met — seller may review offers.</p>}
            <Link to="/live" className="mt-5 inline-flex h-11 items-center rounded-xl bg-primary px-5 font-semibold text-primary-foreground">Browse live rooms</Link>
          </div>
        </div>
      )}

      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent className="max-w-sm">
          <DialogTitle>Confirm your bid</DialogTitle>
          <DialogDescription>Bids are binding on a real platform. This is a demo — no money moves.</DialogDescription>
          <div className="rounded-xl bg-secondary p-4 text-center">
            <p className="text-sm text-muted-foreground">{room.title}</p>
            <p className="text-4xl font-extrabold tabular">{confirm !== null && fmtFull(confirm)}</p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setConfirm(null)} className="h-12 flex-1 rounded-xl border font-semibold">Cancel</button>
            <button onClick={submit} className="h-12 flex-1 rounded-xl bg-primary font-bold text-primary-foreground">Place bid</button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function ActivityPanel({ room }: { room: RoomState }) {
  const [tab, setTab] = useState<"bids" | "chat" | "people" | "ai">("bids");
  const [msg, setMsg] = useState("");
  const [auto, setAuto] = useState(true);
  const chatEnd = useRef<HTMLDivElement>(null);
  useEffect(() => { if (auto && tab === "chat") chatEnd.current?.scrollIntoView({ block: "nearest" }); }, [room.chat.length, tab, auto]);
  const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const pinned = room.chat.find((c) => c.system);

  return (
    <section className="flex h-[560px] flex-col overflow-hidden border-y bg-card sm:rounded-2xl sm:border lg:sticky lg:top-20 2xl:h-[calc(100vh-7rem)]">
      <div className="grid grid-cols-4 border-b text-sm">
        {([["bids", "Bids"], ["chat", "Chat"], ["people", "People"], ["ai", "AI"]] as const).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={cn("relative py-3.5 font-medium text-muted-foreground", tab === k && "text-foreground")}>
            {l}{tab === k && <span className="absolute inset-x-4 bottom-0 h-0.5 rounded bg-primary" />}
          </button>
        ))}
      </div>
      {tab === "bids" && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {room.bids.length === 0 && <p className="p-8 text-center text-sm text-muted-foreground">No bids yet. Be the first.</p>}
          {room.bids.map((b, i) => (
            <div key={b.id} className={cn("flex items-center justify-between border-b px-4 py-3 text-sm", i === 0 && "animate-row bg-primary/5", b.mine && "text-success")}>
              <div><p className="font-medium">{b.mine ? "You" : b.user}{i === 0 && <span className="ml-2 text-[10px] font-bold uppercase text-primary">Highest</span>}</p><p className="text-xs text-muted-foreground">{time(b.at)}</p></div>
              <p className="font-bold tabular">{fmtFull(b.amount)}</p>
            </div>
          ))}
        </div>
      )}
      {tab === "chat" && (
        <>
          {pinned && <div className="flex gap-2 border-b bg-primary/5 px-4 py-2.5 text-xs text-muted-foreground"><Pin className="mt-0.5 size-3.5 shrink-0 text-primary" />{pinned.text}</div>}
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            {room.chat.filter((c) => !c.system).map((c) => (
              <div key={c.id} className={cn("flex flex-col", c.user === MY_HANDLE && "items-end")}>
                <p className="mb-0.5 text-[11px] text-muted-foreground">{c.user === MY_HANDLE ? "You" : c.user}{c.mod && <span className="ml-1 rounded bg-primary/20 px-1 text-primary">MOD</span>} · {new Date(c.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>
                <p className={cn("max-w-[85%] rounded-2xl px-3.5 py-2 text-sm", c.user === MY_HANDLE ? "bg-primary text-primary-foreground" : "bg-secondary")}>{c.text}</p>
              </div>
            ))}
            <div ref={chatEnd} />
          </div>
          <form onSubmit={(e) => { e.preventDefault(); sendChat(room.id, msg); setMsg(""); }} className="flex gap-2 border-t p-3">
            <input value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Say something…" className="h-11 min-w-0 flex-1 rounded-xl border bg-background px-3 text-sm outline-none focus:border-primary" />
            <button aria-label="Send" disabled={!msg.trim()} className="grid size-11 place-items-center rounded-xl bg-primary text-primary-foreground disabled:opacity-40"><Send className="size-4" /></button>
          </form>
          <label className="flex items-center gap-2 border-t px-4 py-2 text-xs text-muted-foreground"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto-scroll</label>
        </>
      )}
      {tab === "people" && (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-secondary p-4"><p className="text-2xl font-bold tabular">{room.viewers}</p><p className="text-xs text-muted-foreground">Online viewers</p></div>
            <div className="rounded-xl bg-secondary p-4"><p className="text-2xl font-bold tabular">{new Set(room.bids.map((b) => b.user)).size}</p><p className="text-xs text-muted-foreground">Active bidders</p></div>
          </div>
          <p className="mb-2 mt-5 text-xs font-semibold uppercase tracking-widest text-muted-foreground">In the room</p>
          {room.participants.map((p) => <div key={p} className="flex items-center gap-3 py-2 text-sm"><span className="grid size-8 place-items-center rounded-full bg-accent text-xs font-bold uppercase">{p.slice(0, 2)}</span>{p}<span className="ml-auto size-2 rounded-full bg-success" /></div>)}
        </div>
      )}
      {tab === "ai" && <div className="min-h-0 flex-1"><AiChat key={room.id} context={room} compact /></div>}
    </section>
  );
}

export { X };
