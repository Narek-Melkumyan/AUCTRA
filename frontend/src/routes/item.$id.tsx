import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { loadAuctionMeta } from "@/lib/auction-meta";
import { BellRing, Flag, MapPin, MessageSquare, Radio, Share2, ShieldCheck } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useSession } from "@/lib/demo-session";
import { ApiError } from "@/lib/api/client";
import { toast } from "sonner";
import { buyerFees, fmtFull } from "@/lib/auctions";
import { IS_API_MODE } from "@/lib/auction-store";
import { useCheckoutTerms } from "@/lib/api/checkout";
import { useRoom, useRooms } from "@/lib/auction-store";
import { AuctionCard, Countdown, StatusBadge, WatchButton } from "@/components/auction/bits";
import { FavoriteButton } from "@/components/auction/FavoriteButton";
import { cn } from "@/lib/utils";
import { AuctionImage } from "@/components/auction/AuctionImage";
import { photoOf } from "@/lib/media";

export const Route = createFileRoute("/item/$id")({
  loader: ({ params }) => loadAuctionMeta(params.id),
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
  const terms = useCheckoutTerms(IS_API_MODE);
  useEffect(() => {
    if (IS_API_MODE) void import("@/lib/api/live").then((m) => m.ensureRoom(id));
  }, [id]);
  if (!r)
    return (
      <div className="mx-auto max-w-[1440px] px-4 py-10 sm:px-6 lg:px-10">
        <div className="grid gap-10 lg:grid-cols-[1.4fr_1fr]">
          <div className="aspect-[4/3] animate-pulse rounded-3xl bg-muted/40" />
          <div className="h-96 animate-pulse rounded-3xl bg-muted/40" />
        </div>
      </div>
    );
  // API mode: buyer's premium from the server's configured rate (no platform fee);
  // demo mode keeps the local illustrative model.
  const fees = IS_API_MODE
    ? (() => {
        const premium = Math.round((r.currentBid * (terms.data?.buyerPremiumBps ?? 0)) / 10_000);
        return { premium, platform: 0, total: r.currentBid + premium };
      })()
    : buyerFees(r.currentBid);
  const related = all
    .filter((x) => x.id !== r.id && (x.category === r.category || x.status === "live"))
    .slice(0, 4);
  return (
    <div className="mx-auto max-w-[1440px] px-4 py-10 sm:px-6 lg:px-10">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/explore" className="hover:text-foreground">
          Explore
        </Link>{" "}
        /{" "}
        <Link
          to="/explore"
          search={{ category: r.categorySlug ?? r.category }}
          className="hover:text-foreground"
        >
          {r.category}
        </Link>
      </nav>
      <div className="grid gap-10 lg:grid-cols-[1.3fr_1fr]">
        <div>
          <div className="relative overflow-hidden rounded-3xl border">
            <AuctionImage
              photo={photoOf(r, img)}
              size="full"
              eager
              alt={r.title}
              className="aspect-[4/3] w-full object-cover"
            />
            <div className="absolute left-4 top-4">
              <StatusBadge room={r} />
            </div>
          </div>
          <PhotoCredit credit={photoOf(r, img)?.credit} />
          <div className="mt-3 flex gap-2">
            {r.images.length > 1 &&
              r.images.map((_, i) => (
                <button
                  key={i}
                  onClick={() => setImg(i)}
                  className={cn(
                    "overflow-hidden rounded-xl border-2",
                    i === img ? "border-primary" : "border-transparent opacity-60",
                  )}
                >
                  <AuctionImage
                    photo={photoOf(r, i)}
                    size="thumb"
                    sizes="80px"
                    alt={`Photo ${i + 1}`}
                    className="size-20 object-cover"
                  />
                </button>
              ))}
          </div>
          <div className="mt-10 space-y-8">
            <div>
              <h2 className="mb-4 text-xl font-semibold">Specifications</h2>
              <dl className="grid gap-px overflow-hidden rounded-2xl border bg-border sm:grid-cols-2">
                {r.specs.map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-4 bg-card p-4 text-sm">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="text-right font-medium">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <div>
              <h2 className="mb-2 text-xl font-semibold">Condition report</h2>
              <p className="text-muted-foreground">
                Seller-rated <span className="text-foreground">{r.condition}</span>. {r.inspection}
              </p>
            </div>
            <div>
              <h2 className="mb-2 text-xl font-semibold">Shipping</h2>
              <p className="text-muted-foreground">{r.shipping}</p>
            </div>
          </div>
        </div>
        <aside className="h-fit space-y-5 lg:sticky lg:top-24">
          <p className="text-xs uppercase tracking-widest text-muted-foreground">
            {r.lot} · {r.subcategory ? `${r.category} · ${r.subcategory}` : r.category}
            {r.demo && (
              <span
                title="Seeded demonstration listing — not a real item for sale"
                className="ml-2 rounded border px-1.5 py-0.5 text-[10px] font-semibold normal-case tracking-normal"
              >
                Demo listing
              </span>
            )}
          </p>
          <h1 className="font-display text-4xl leading-tight sm:text-4xl">{r.title}</h1>
          {r.location && (
            <p className="inline-flex items-center gap-1 text-sm text-muted-foreground">
              <MapPin className="size-4" />
              {r.location}
            </p>
          )}
          <div className="rounded-3xl border bg-card p-6 shadow-card">
            <div className="flex items-end justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Current bid</p>
                <p key={r.currentBid} className="animate-bump text-4xl font-semibold tabular">
                  {fmtFull(r.currentBid)}
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm text-muted-foreground">
                  {r.status === "upcoming" ? "Opens" : "Ends in"}
                </p>
                <Countdown room={r} className="text-2xl font-semibold" />
              </div>
            </div>
            <p
              className={cn(
                "mt-3 text-sm",
                r.reserve === "met"
                  ? "text-success"
                  : r.reserve === "not-met"
                    ? "text-live"
                    : "text-muted-foreground",
              )}
            >
              {r.reserve === "met"
                ? "Reserve met"
                : r.reserve === "not-met"
                  ? "Reserve not yet met"
                  : "No reserve"}{" "}
              · {r.bids.length} bids · {r.watchers} watching
            </p>
            {r.buyNow && (
              <p className="mt-1 text-sm text-muted-foreground">
                Buy Now available at {fmtFull(r.buyNow)}
              </p>
            )}
            <Link
              to="/room/$id"
              params={{ id: r.id }}
              className="mt-5 flex h-13 items-center justify-center gap-2 rounded-2xl bg-primary py-4 font-semibold text-primary-foreground"
            >
              <Radio className="size-5" /> View Live Auction Room
            </Link>
            <div className="mt-3 flex gap-2">
              <WatchButton id={r.id} className="size-12 border" />
              <FavoriteButton id={r.id} className="size-12 border" />
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(window.location.href);
                  toast.success("Link copied");
                }}
                className="inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-full border font-semibold"
              >
                <Share2 className="size-4" /> Share
              </button>
            </div>
            {IS_API_MODE && r.status === "upcoming" && (
              <RemindMe auctionId={r.id} startsAt={r.startsAt} />
            )}
            {IS_API_MODE && !r.viewerIsSeller && <MessageSeller auctionId={r.id} />}
            {IS_API_MODE && <ReportListing auctionId={r.id} />}
          </div>
          <div className="rounded-3xl border p-6 text-sm">
            <p className="mb-3 font-semibold">Fees preview (if you win now)</p>
            <div className="space-y-2 text-muted-foreground">
              <Row l="Hammer price" v={fmtFull(r.currentBid)} />
              <Row
                l={
                  IS_API_MODE
                    ? `Buyer's premium (${(terms.data?.buyerPremiumBps ?? 0) / 100}%)`
                    : "Buyer's premium (10%, max $25k)"
                }
                v={fmtFull(fees.premium)}
              />
              {!IS_API_MODE && <Row l="Platform fee" v={fmtFull(fees.platform)} />}
              <div className="border-t pt-2 text-foreground">
                <Row l="Estimated total" v={fmtFull(fees.total)} />
              </div>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              {IS_API_MODE
                ? "Rates from AUCTRA's platform configuration. Delivery is chosen at the demo checkout; no real payment is ever taken."
                : "Demo fee model. Excludes shipping and taxes."}
            </p>
          </div>
          <div className="flex items-center gap-3 rounded-3xl border p-5">
            <span className="grid size-11 place-items-center rounded-full bg-accent font-semibold">
              {r.seller[0]}
            </span>
            <div className="min-w-0 flex-1">
              {r.sellerHandle ? (
                <Link
                  to="/sellers/$handle"
                  params={{ handle: r.sellerHandle }}
                  className="font-semibold hover:underline"
                >
                  {r.seller}
                </Link>
              ) : (
                <p className="font-semibold">{r.seller}</p>
              )}
              <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                {r.verified && <ShieldCheck className="size-3.5 text-primary" />}
                {r.verified ? "Verified" : "Unverified"} {r.sellerType.toLowerCase()} seller
              </p>
            </div>
          </div>
        </aside>
      </div>
      <h2 className="mb-6 mt-20 font-display text-4xl">Related auctions</h2>
      <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
        {related.map((x) => (
          <AuctionCard key={x.id} room={x} />
        ))}
      </div>
    </div>
  );
}
const Row = ({ l, v }: { l: string; v: string }) => (
  <div className="flex justify-between gap-4">
    <span>{l}</span>
    <span className="tabular">{v}</span>
  </div>
);

const REPORT_REASONS = [
  ["counterfeit", "Possibly counterfeit"],
  ["misleading", "Misleading description or photos"],
  ["prohibited", "Prohibited item"],
  ["other", "Something else"],
] as const;

/** Sends the listing to the moderation queue (API mode, signed-in users). */
function ReportListing({ auctionId }: { auctionId: string }) {
  const user = useSession((s) => s.user);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>(REPORT_REASONS[0][0]);
  const [sent, setSent] = useState(false);
  if (!user) return null;
  if (sent)
    return (
      <p className="mt-3 text-center text-xs text-muted-foreground">Reported to moderators.</p>
    );
  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mx-auto mt-3 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <Flag className="size-3.5" /> Report this listing
      </button>
    );
  return (
    <form
      className="mt-3 flex items-center gap-2 text-xs"
      onSubmit={(e) => {
        e.preventDefault();
        void import("@/services/api")
          .then((m) => m.reportListing(auctionId, reason))
          .then(() => setSent(true))
          .catch((err: unknown) =>
            toast.error(err instanceof ApiError ? err.message : "Couldn't send the report."),
          );
      }}
    >
      <select
        aria-label="Report reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2"
      >
        {REPORT_REASONS.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      <button className="h-9 rounded-md border px-3 font-medium">Send</button>
      <button type="button" className="h-9 px-1" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  );
}

/** Starts (or continues) the private thread with this lot's seller. */
function MessageSeller({ auctionId }: { auctionId: string }) {
  const user = useSession((s) => s.user);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  if (!open)
    return (
      <button
        type="button"
        onClick={() => (user ? setOpen(true) : void navigate({ to: "/login" }))}
        className="mt-2 inline-flex h-12 w-full items-center justify-center gap-2 rounded-full border font-semibold"
      >
        <MessageSquare className="size-4" /> Message the seller
      </button>
    );
  return (
    <form
      className="mt-3 space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        const body = text.trim();
        if (!body) return;
        setBusy(true);
        void import("@/lib/api/messages")
          .then((m) => m.messagesApi.start(auctionId, body))
          .then((t) => navigate({ to: "/messages", search: { c: t.id } }))
          .catch((err: unknown) =>
            toast.error(err instanceof ApiError ? err.message : "Couldn't send the message."),
          )
          .finally(() => setBusy(false));
      }}
    >
      <textarea
        autoFocus
        value={text}
        maxLength={4000}
        rows={3}
        onChange={(e) => setText(e.target.value)}
        placeholder="Ask about condition, provenance, delivery…"
        aria-label="Message to the seller"
        className="w-full rounded-xl border bg-background px-3 py-2 text-sm outline-none focus:border-ring"
      />
      <div className="flex justify-end gap-2 text-sm">
        <button type="button" className="h-9 px-3" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button
          disabled={busy || !text.trim()}
          className="h-9 rounded-md bg-primary px-4 font-medium text-primary-foreground disabled:opacity-40"
        >
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
    </form>
  );
}

/** Attribution for third-party photos (author, license, source), as their licenses require. */
function PhotoCredit({ credit }: { credit: import("@/lib/media").Photo["credit"] }) {
  if (!credit) return null;
  const link = "underline underline-offset-2 hover:text-foreground";
  return (
    <p className="mt-2 text-[11px] text-muted-foreground">
      Photo
      {credit.author ? `: ${credit.author}` : ""} ·{" "}
      {credit.licenseUrl ? (
        <a
          href={credit.licenseUrl}
          target="_blank"
          rel="noopener noreferrer license"
          className={link}
        >
          {credit.license}
        </a>
      ) : (
        credit.license
      )}
      {credit.sourceUrl && (
        <>
          {" "}
          ·{" "}
          <a href={credit.sourceUrl} target="_blank" rel="noopener noreferrer" className={link}>
            Wikimedia Commons
          </a>
        </>
      )}
      {credit.notice && <span className="block">{credit.notice}</span>}
    </p>
  );
}

/** Upcoming lots: a reminder notification before bidding opens (server-side reminders). */
function RemindMe({ auctionId, startsAt }: { auctionId: string; startsAt: number }) {
  const user = useSession((s) => s.user);
  const navigate = useNavigate();
  const [state, setState] = useState<{ id: string } | null | undefined>(undefined);
  useEffect(() => {
    if (!user) return;
    let alive = true;
    void import("@/lib/api/client")
      .then((m) => m.api<{ id: string; auctionId: string }[]>("/me/reminders"))
      .then((list) => alive && setState(list.find((x) => x.auctionId === auctionId) ?? null))
      .catch(() => alive && setState(null));
    return () => {
      alive = false;
    };
  }, [user, auctionId]);
  const remindAt = () => {
    // 30 minutes before the start, or halfway there if it starts sooner.
    const lead = Math.min(30 * 60_000, (startsAt - Date.now()) / 2);
    return new Date(startsAt - lead).toISOString();
  };
  const toggle = async () => {
    if (!user) return void navigate({ to: "/login" });
    const { api } = await import("@/lib/api/client");
    try {
      if (state) {
        await api(`/me/reminders/${state.id}`, { method: "DELETE" });
        setState(null);
        toast.success("Reminder removed");
      } else {
        const r = await api<{ id: string }>("/me/reminders", {
          method: "POST",
          body: { auctionId, remindAt: remindAt() },
        });
        setState({ id: r.id });
        toast.success("We'll notify you before bidding opens.");
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't update the reminder.");
    }
  };
  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={Boolean(user) && state === undefined}
      aria-pressed={Boolean(state)}
      className="mt-2 inline-flex h-12 w-full items-center justify-center gap-2 rounded-full border font-semibold disabled:opacity-50"
    >
      <BellRing className="size-4" />{" "}
      {state ? "Reminder set — remove" : "Remind me before it starts"}
    </button>
  );
}
