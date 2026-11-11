import { createFileRoute, Link } from "@tanstack/react-router";
import { AccountLayout, Empty, btn, metaFor } from "@/components/account/AccountLayout";
import { orderStatusLabel, useSession } from "@/lib/demo-session";
import { buyerFees, fmtFull } from "@/lib/auctions";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/orders")({
  head: () => ({ meta: metaFor("Order history", "Your won lots, payments and shipping status.") }),
  component: Orders,
});

const steps = ["processing", "shipped", "delivered"] as const;

function Orders() {
  const orders = useSession((s) => s.orders);
  return (
    <AccountLayout title="Order history" description="Sample orders plus any demo checkouts you complete.">
      {orders.length === 0 ? <Empty title="No orders yet" body="Win an auction to see it here." action={<Link to="/live" className={btn}>Live auctions</Link>} /> : (
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
                  <p className="shrink-0 text-sm tabular">{fmtFull(buyerFees(o.hammer).total)}</p>
                </div>
                <ol className="mt-4 grid grid-cols-3 gap-2" aria-label="Shipping progress">
                  {steps.map((s, i) => (
                    <li key={s}><div className={cn("h-1 rounded-full", i <= idx ? "bg-primary" : "bg-muted")} /><p className="mt-1.5 text-[11px] capitalize text-muted-foreground">{s}</p></li>
                  ))}
                </ol>
              </li>
            );
          })}
        </ul>
      )}
    </AccountLayout>
  );
}
