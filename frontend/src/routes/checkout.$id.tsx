import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Empty, btn, input, metaFor } from "@/components/account/AccountLayout";
import { IS_API_MODE, isWonByMe, useRoom } from "@/lib/auction-store";
import { DemoCheckout } from "@/components/checkout/DemoCheckout";
import { services } from "@/services";
import { buyerFees, fmtFull } from "@/lib/auctions";
import { cn } from "@/lib/utils";
import { AuctionImage } from "@/components/auction/AuctionImage";
import { photoOf } from "@/lib/media";

export const Route = createFileRoute("/checkout/$id")({
  head: () => ({
    meta: metaFor(
      "Demo checkout",
      "Simulated checkout for your won lot — no real payment required.",
    ),
  }),
  component: () => (IS_API_MODE ? <DemoCheckout /> : <LocalCheckout />),
});

/** Demo mode (VITE_API_MODE=demo): in-browser simulation only. */
function LocalCheckout() {
  const { id } = Route.useParams();
  const room = useRoom(id);
  const nav = useNavigate();
  const [delivery, setDelivery] = useState("Insured shipping");
  const won = room ? isWonByMe(room) : false;
  if (!room || !won) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16">
        <Empty
          title="Checkout isn't available for this lot"
          body={
            room?.status === "ended" && room.reserve === "not-met"
              ? "The reserve was not met, so no sale was completed."
              : room
                ? "Checkout opens once you've won the auction and it has closed."
                : "We couldn't find this lot."
          }
          action={
            <Link to="/bids" className={btn}>
              Go to my bids
            </Link>
          }
        />
      </div>
    );
  }
  const f = buyerFees(room.currentBid);
  const ship = delivery === "Buyer pickup" ? 0 : delivery === "White-glove" ? 950 : 240;
  const place = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    if (delivery !== "Buyer pickup" && !String(d.get("address") ?? "").trim()) {
      toast.error("Enter a delivery address.");
      return;
    }
    void services.orders
      .createFromWin({
        auctionId: room.id,
        title: room.title,
        ...(room.images[0] === undefined ? {} : { image: room.images[0] }),
        hammer: room.currentBid,
      })
      .then((r) => {
        if (!r.ok) {
          toast.error(r.error);
          return;
        }
        toast.success("Demo order completed — no real payment was made");
        void nav({ to: "/orders" });
      })
      .catch(() => toast.error("Couldn't create the order. Please try again."));
  };
  return (
    <div className="mx-auto grid max-w-[1080px] gap-10 px-4 py-10 sm:px-6 lg:grid-cols-[1fr_360px]">
      <form onSubmit={place} className="space-y-8">
        <div>
          <h1 className="text-2xl font-medium tracking-tight">Demo checkout</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Lot {room.id.slice(1)} · {room.title}
          </p>
        </div>
        <fieldset>
          <legend className="mb-3 text-sm font-medium">Delivery</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {[
              ["Buyer pickup", 0],
              ["Insured shipping", 240],
              ["White-glove", 950],
            ].map(([l, c]) => (
              <button
                type="button"
                key={l}
                onClick={() => setDelivery(l as string)}
                className={cn(
                  "rounded-md border p-3 text-left text-sm",
                  delivery === l && "border-foreground",
                )}
              >
                {l}
                <span className="block text-xs text-muted-foreground tabular">
                  {c ? fmtFull(c as number) : "Free"}
                </span>
              </button>
            ))}
          </div>
          {delivery !== "Buyer pickup" && (
            <label className="mt-4 block text-sm">
              Delivery address
              <textarea name="address" rows={3} className={cn(input, "mt-1.5 h-auto py-2")} />
            </label>
          )}
        </fieldset>
        <fieldset>
          <legend className="mb-3 text-sm font-medium">Payment</legend>
          <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            Simulated transaction — no real payment required. AUCTRA is a demo and never collects
            card details.
          </div>
        </fieldset>
        <button className={cn(btn, "h-10 w-full sm:w-auto")}>Complete demo purchase</button>
      </form>
      <aside className="h-fit rounded-lg border bg-card p-5 lg:sticky lg:top-24">
        <AuctionImage
          photo={photoOf(room)}
          size="card"
          sizes="320px"
          alt=""
          className="aspect-[4/3] w-full rounded-md object-cover"
        />
        <dl className="mt-4 space-y-2 text-sm">
          {[
            ["Hammer price", room.currentBid],
            ["Buyer's premium", f.premium],
            ["Platform fee", f.platform],
            ["Delivery", ship],
          ].map(([k, v]) => (
            <div key={k as string} className="flex justify-between">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="tabular">{fmtFull(v as number)}</dd>
            </div>
          ))}
          <div className="flex justify-between border-t pt-3 font-medium">
            <dt>Total</dt>
            <dd className="tabular">{fmtFull(f.total + ship)}</dd>
          </div>
        </dl>
      </aside>
    </div>
  );
}
