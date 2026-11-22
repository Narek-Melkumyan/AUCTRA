import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  adminApi,
  fmtDate,
  fmtMoney,
  type AdminAccess,
  type AdminDispute,
  type Party,
} from "@/lib/api/admin";
import {
  ConfirmDialog,
  EmptyRow,
  ErrorState,
  Loading,
  Pager,
  Pill,
  Section,
  btnDanger,
  btnSm,
  select,
  td,
  th,
  useAdminAction,
  useConfirm,
} from "./shared";

const ORDER_STATUSES = [
  "PENDING_PAYMENT",
  "COMPLETED",
  "DISPUTED",
  "CANCELLED",
  "PAID",
  "SHIPPED",
  "DELIVERED",
  "REFUNDED",
];
const who = (p: Party) => (p.handle ? `@${p.handle}` : (p.displayName ?? p.email));

/** Order book (order:read:any) and dispute handling (dispute:handle). Demo orders only. */
export function OrdersPanel({ access }: { access: AdminAccess }) {
  return (
    <div className="space-y-6">
      {access.disputes && <DisputesSection />}
      {access.orders && <OrdersSection />}
    </div>
  );
}

function OrdersSection() {
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ["admin", "orders", { status, page }],
    queryFn: () => adminApi.orders({ status: status || undefined, page }),
  });
  return (
    <Section
      title="Orders"
      description="Created automatically when an auction sells. Checkout is simulated — no payment is ever taken."
      actions={
        <select
          aria-label="Filter orders by status"
          className={select}
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          {ORDER_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replace(/_/g, " ").toLowerCase()}
              {q.data?.counts[s] ? ` (${q.data.counts[s]})` : ""}
            </option>
          ))}
        </select>
      }
    >
      {q.isPending ? (
        <Loading rows={3} />
      ) : q.isError ? (
        <ErrorState error={q.error} retry={() => void q.refetch()} />
      ) : q.data.items.length === 0 ? (
        <EmptyRow>{status ? "No orders with this status." : "No orders yet."}</EmptyRow>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="border-b">
                <tr>
                  <th className={th}>Order</th>
                  <th className={th}>Lot</th>
                  <th className={th}>Buyer → seller</th>
                  <th className={th}>Total</th>
                  <th className={th}>Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {q.data.items.map((o) => (
                  <tr key={o.id}>
                    <td className={td}>
                      <p className="font-medium tabular">{o.orderNumber}</p>
                      <p className="text-xs text-muted-foreground">{fmtDate(o.createdAt)}</p>
                    </td>
                    <td className={td}>
                      <Link
                        to="/item/$id"
                        params={{ id: o.auction.id }}
                        className="hover:underline"
                      >
                        {o.auction.title}
                      </Link>
                      <p className="text-xs text-muted-foreground">Lot {o.auction.lotNumber}</p>
                    </td>
                    <td className={td}>
                      {who(o.buyer)} → {who(o.seller)}
                    </td>
                    <td className={`${td} tabular`}>
                      {fmtMoney(o.total)}
                      {o.buyerPremium.minor !== "0" && (
                        <p className="text-xs text-muted-foreground">
                          incl. premium {fmtMoney(o.buyerPremium)}
                        </p>
                      )}
                    </td>
                    <td className={td}>
                      <Pill value={o.status} />
                      {o.openDisputes > 0 && <p className="mt-1 text-xs text-live">open dispute</p>}
                      {o.demoCompletedAt && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          demo checkout {fmtDate(o.demoCompletedAt)}
                        </p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={page} total={q.data.total} limit={q.data.limit} onPage={setPage} />
        </>
      )}
    </Section>
  );
}

type Decision = { dispute: AdminDispute; status: "RESOLVED_BUYER" | "RESOLVED_SELLER" | "CLOSED" };

function DisputesSection() {
  const [status, setStatus] = useState("OPEN");
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ["admin", "disputes", { status, page }],
    queryFn: () => adminApi.disputes({ status: status || undefined, page }),
  });
  const decide = useAdminAction(
    (a: {
      id: string;
      status: Parameters<typeof adminApi.decideDispute>[1];
      resolution?: string;
    }) => adminApi.decideDispute(a.id, a.status, a.resolution),
    {
      success: "Dispute updated; both parties were notified of any decision",
      invalidate: [
        ["admin", "disputes"],
        ["admin", "orders"],
      ],
    },
  );
  const confirm = useConfirm<Decision>();
  const labels: Record<Decision["status"], string> = {
    RESOLVED_BUYER: "Resolve for buyer (order cancelled)",
    RESOLVED_SELLER: "Resolve for seller",
    CLOSED: "Close without decision",
  };

  return (
    <Section
      title="Disputes"
      description="Opened by a buyer or seller on an order. Decisions are audited and sent to both parties."
      actions={
        <select
          aria-label="Filter disputes by status"
          className={select}
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="OPEN">Open</option>
          <option value="UNDER_REVIEW">Under review</option>
          <option value="RESOLVED_BUYER">Resolved for buyer</option>
          <option value="RESOLVED_SELLER">Resolved for seller</option>
          <option value="CLOSED">Closed</option>
          <option value="">All</option>
        </select>
      }
    >
      {q.isPending ? (
        <Loading rows={2} />
      ) : q.isError ? (
        <ErrorState error={q.error} retry={() => void q.refetch()} />
      ) : q.data.items.length === 0 ? (
        <EmptyRow>No disputes{status ? " with this status" : ""}.</EmptyRow>
      ) : (
        <>
          <ul className="divide-y">
            {q.data.items.map((d) => {
              const active = d.status === "OPEN" || d.status === "UNDER_REVIEW";
              return (
                <li key={d.id} className="space-y-2 px-5 py-4 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill value={d.status} />
                    <span className="font-medium">{d.order.orderNumber}</span>
                    <span className="text-muted-foreground">
                      · {d.order.auction.title} · {fmtMoney(d.order.total)}
                    </span>
                  </div>
                  <p>
                    <span className="text-muted-foreground">
                      {d.openedByRole} {who(d.openedBy)} · {fmtDate(d.createdAt)} ·{" "}
                    </span>
                    {d.reason.replace(/_/g, " ")}
                    {d.details && <span className="text-muted-foreground"> — {d.details}</span>}
                  </p>
                  {d.resolution && (
                    <p className="text-xs text-muted-foreground">
                      Decision{d.handledBy ? ` by ${who(d.handledBy)}` : ""}: {d.resolution}
                    </p>
                  )}
                  {active && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      {d.status === "OPEN" && (
                        <button
                          className={btnSm}
                          disabled={decide.isPending}
                          onClick={() => decide.mutate({ id: d.id, status: "UNDER_REVIEW" })}
                        >
                          Start review
                        </button>
                      )}
                      <button
                        className={btnSm}
                        onClick={() => confirm.open({ dispute: d, status: "RESOLVED_SELLER" })}
                      >
                        Resolve for seller
                      </button>
                      <button
                        className={btnDanger}
                        onClick={() => confirm.open({ dispute: d, status: "RESOLVED_BUYER" })}
                      >
                        Resolve for buyer
                      </button>
                      <button
                        className={btnSm}
                        onClick={() => confirm.open({ dispute: d, status: "CLOSED" })}
                      >
                        Close
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <Pager page={page} total={q.data.total} limit={q.data.limit} onPage={setPage} />
        </>
      )}
      <ConfirmDialog
        {...confirm.props}
        title={confirm.target ? `${labels[confirm.target.status]}?` : ""}
        description={
          confirm.target
            ? `Order ${confirm.target.dispute.order.orderNumber}. The buyer and seller both receive your explanation.`
            : undefined
        }
        reasonLabel="Decision (shown to both parties)"
        reasonRequired
        danger={confirm.target?.status === "RESOLVED_BUYER"}
        confirmLabel="Save decision"
        pending={decide.isPending}
        onConfirm={(resolution) => {
          const t = confirm.target!;
          confirm.close();
          decide.mutate({ id: t.dispute.id, status: t.status, resolution });
        }}
      />
    </Section>
  );
}
