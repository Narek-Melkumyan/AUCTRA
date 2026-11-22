import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { ApiError } from "@/lib/api/client";
import { AccountLayout, Empty, btn, metaFor } from "@/components/account/AccountLayout";
import { orderStatusLabel, useSession } from "@/lib/demo-session";
import { buyerFees, fmtFull } from "@/lib/auctions";
import { IS_API_MODE } from "@/lib/auction-store";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/orders")({
  head: () => ({
    meta: metaFor("Order history", "Your won lots and demo checkouts (simulated transactions)."),
  }),
  component: Orders,
});

const steps = ["processing", "shipped", "delivered"] as const;

function Orders() {
  const orders = useSession((s) => s.orders);
  return (
    <AccountLayout
      title="Order history"
      description={
        IS_API_MODE
          ? "Lots you won. Checkout is simulated — no real payments are taken."
          : "Sample orders plus any demo checkouts you complete."
      }
    >
      {orders.length === 0 ? (
        <Empty
          title="No orders yet"
          body="Win an auction to see it here."
          action={
            <Link to="/live" className={btn}>
              Live auctions
            </Link>
          }
        />
      ) : (
        <ul className="space-y-3">
          {orders.map((o) => {
            const idx = steps.indexOf(o.status as (typeof steps)[number]);
            return (
              <li key={o.id} className="rounded-lg border bg-card p-4">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span className="text-xs text-muted-foreground tabular">{o.id}</span>
                  <span className="text-xs text-muted-foreground">{o.date}</span>
                  <span className="ml-auto text-xs">{orderStatusLabel[o.status]}</span>
                </div>
                <div className="mt-2 flex items-center justify-between gap-4">
                  <p className="min-w-0 truncate text-sm font-medium">{o.title}</p>
                  <p className="shrink-0 text-sm tabular">
                    {fmtFull(o.total ?? buyerFees(o.hammer).total)}
                  </p>
                </div>
                {o.status === "disputed" ? (
                  <p className="mt-3 text-xs text-muted-foreground">
                    You opened a dispute. Staff are reviewing it; you'll get a notification with
                    their decision.
                  </p>
                ) : o.status === "cancelled" ? (
                  <p className="mt-3 text-xs text-muted-foreground">
                    This order was cancelled. No payment was taken.
                  </p>
                ) : o.status === "completed" || o.status === "pending_payment" ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                    {o.status === "completed" ? (
                      <span className="rounded-full bg-success/15 px-2 py-0.5 font-semibold text-success">
                        Demo Order Completed
                      </span>
                    ) : (
                      o.auctionId && (
                        <Link
                          to="/checkout/$id"
                          params={{ id: o.auctionId }}
                          className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground"
                        >
                          Complete demo checkout
                        </Link>
                      )
                    )}
                    <span className="text-muted-foreground">
                      Simulated transaction · no real payment
                    </span>
                    {IS_API_MODE && o.orderId && <DisputeButton orderId={o.orderId} />}
                  </div>
                ) : (
                  <ol className="mt-4 grid grid-cols-3 gap-2" aria-label="Shipping progress">
                    {steps.map((s, i) => (
                      <li key={s}>
                        <div
                          className={cn("h-1 rounded-full", i <= idx ? "bg-primary" : "bg-muted")}
                        />
                        <p className="mt-1.5 text-[11px] capitalize text-muted-foreground">{s}</p>
                      </li>
                    ))}
                  </ol>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </AccountLayout>
  );
}

const REASONS = [
  ["not_as_described", "Item not as described"],
  ["not_received", "Item not received"],
  ["seller_unresponsive", "Seller not responding"],
  ["other", "Something else"],
] as const;

/** Opens a dispute on the order (API mode); staff decide it in the admin console. */
function DisputeButton({ orderId }: { orderId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>(REASONS[0][0]);
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="ml-auto text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        Report a problem
      </button>
    );
  return (
    <form
      className="mt-2 flex w-full flex-wrap items-end gap-2 rounded-md border bg-background p-3"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void import("@/services/api")
          .then((m) => m.openDispute(orderId, reason, details.trim() || undefined))
          .then(() => {
            toast.success("Dispute opened — staff will review it.");
            setOpen(false);
          })
          .catch((err: unknown) =>
            toast.error(err instanceof ApiError ? err.message : "Couldn't open the dispute."),
          )
          .finally(() => setBusy(false));
      }}
    >
      <label className="text-xs">
        What went wrong?
        <select
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="mt-1 block h-9 rounded-md border bg-background px-2 text-sm"
        >
          {REASONS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <label className="min-w-48 flex-1 text-xs">
        Details (optional)
        <input
          value={details}
          maxLength={4000}
          onChange={(e) => setDetails(e.target.value)}
          className="mt-1 block h-9 w-full rounded-md border bg-background px-2 text-sm"
        />
      </label>
      <button disabled={busy} className={btn}>
        {busy ? "Sending…" : "Open dispute"}
      </button>
      <button type="button" onClick={() => setOpen(false)} className="h-9 px-2 text-xs">
        Cancel
      </button>
    </form>
  );
}
