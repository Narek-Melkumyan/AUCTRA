import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { input } from "@/components/account/AccountLayout";
import { adminApi, fmtDate, fmtMoney, type AdminAccess } from "@/lib/api/admin";
import { cn } from "@/lib/utils";
import { mediaUrl } from "@/lib/api/adapters";
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

const STATUSES = [
  "PENDING_REVIEW",
  "SCHEDULED",
  "LIVE",
  "ENDED",
  "SOLD",
  "UNSOLD",
  "CANCELLED",
  "DRAFT",
];
const CATEGORIES = [
  ["cars", "Cars"],
  ["watches", "Watches"],
  ["jewelry", "Jewelry"],
  ["art", "Art"],
  ["real-estate", "Real estate"],
  ["collectibles", "Collectibles"],
];

export function AuctionsPanel({
  access,
  sellerFilter,
  clearSeller,
}: {
  access: AdminAccess;
  sellerFilter?: { id: string; label: string } | null;
  clearSeller?: () => void;
}) {
  return (
    <div className="space-y-6">
      {access.moderateAuctions && <ReviewQueue />}
      <AllAuctions access={access} sellerFilter={sellerFilter ?? null} clearSeller={clearSeller} />
    </div>
  );
}

function ReviewQueue() {
  const q = useQuery({ queryKey: ["admin", "review"], queryFn: adminApi.reviewQueue });
  const inv = [
    ["admin", "review"],
    ["admin", "auctions"],
    ["admin", "analytics"],
  ];
  const approve = useAdminAction((id: string) => adminApi.approve(id), {
    success: "Listing approved",
    invalidate: inv,
  });
  const reject = useAdminAction(
    (a: { id: string; reason: string }) => adminApi.reject(a.id, a.reason),
    {
      success: "Changes requested",
      invalidate: inv,
    },
  );
  const confirm = useConfirm<string>();
  return (
    <Section
      title="Pending review"
      description="New listings wait here until approved (AUCTION_REQUIRE_REVIEW)."
    >
      {q.isPending ? (
        <Loading rows={2} />
      ) : q.isError ? (
        <ErrorState error={q.error} retry={() => void q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyRow>No listings are waiting for review.</EmptyRow>
      ) : (
        <ul className="divide-y">
          {q.data.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
              {a.media[0] && (
                <img
                  src={
                    a.media[0].variants?.thumbnail.url ?? mediaUrl(a.media[0].url, a.category.slug)
                  }
                  alt=""
                  loading="lazy"
                  className="size-12 rounded-lg object-cover"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="font-medium">{a.title}</p>
                <p className="text-xs text-muted-foreground">
                  {a.category.name} · @{a.seller.handle} · starts {fmtDate(a.startsAt)} · from{" "}
                  {fmtMoney(a.startingPrice)}
                </p>
              </div>
              <button
                className={btnSm}
                disabled={approve.isPending}
                onClick={() => approve.mutate(a.id)}
              >
                Approve
              </button>
              <button className={btnDanger} onClick={() => confirm.open(a.id)}>
                Request changes
              </button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        {...confirm.props}
        title="Send this listing back to the seller?"
        description="The listing returns to draft and the seller is notified with your reason."
        reasonLabel="What needs to change?"
        reasonRequired
        confirmLabel="Request changes"
        pending={reject.isPending}
        onConfirm={(reason) => {
          const id = confirm.target!;
          confirm.close();
          reject.mutate({ id, reason });
        }}
      />
    </Section>
  );
}

function AllAuctions({
  access,
  sellerFilter,
  clearSeller,
}: {
  access: AdminAccess;
  sellerFilter: { id: string; label: string } | null;
  clearSeller?: (() => void) | undefined;
}) {
  const [f, setF] = useState({ status: "", category: "", q: "" });
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["admin", "auctions", f, sellerFilter?.id, page],
    queryFn: () =>
      adminApi.auctions({ ...f, page, ...(sellerFilter ? { sellerId: sellerFilter.id } : {}) }),
    placeholderData: keepPreviousData,
  });
  const set = (k: keyof typeof f, v: string) => {
    setPage(1);
    setF((x) => ({ ...x, [k]: v }));
  };
  return (
    <Section
      title="All auctions"
      description={
        sellerFilter ? (
          <>
            Showing listings by {sellerFilter.label}.{" "}
            <button className="underline" onClick={clearSeller}>
              Show all
            </button>
          </>
        ) : (
          "Filter by status, category or seller; open a row for bid history, winner and order."
        )
      }
      actions={
        <>
          <input
            value={f.q}
            onChange={(e) => set("q", e.target.value)}
            placeholder="Title or lot #"
            aria-label="Search auctions"
            className={cn(input, "h-9 w-44")}
          />
          <select
            aria-label="Status"
            value={f.status}
            onChange={(e) => set("status", e.target.value)}
            className={select}
          >
            <option value="">Any status</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace("_", " ").toLowerCase()}
              </option>
            ))}
          </select>
          <select
            aria-label="Category"
            value={f.category}
            onChange={(e) => set("category", e.target.value)}
            className={select}
          >
            <option value="">Any category</option>
            {CATEGORIES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </>
      }
    >
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorState error={q.error} retry={() => void q.refetch()} />
      ) : q.data.items.length === 0 ? (
        <EmptyRow>No auctions match these filters.</EmptyRow>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] text-sm">
              <thead className="border-b">
                <tr>
                  {[
                    "Lot",
                    "Title",
                    "Status",
                    "Category",
                    "Seller",
                    "Price",
                    "Bids",
                    "Winner / order",
                    "Ends",
                  ].map((h) => (
                    <th key={h} className={th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((a) => (
                  <tr
                    key={a.id}
                    onClick={() => setOpenId(a.id)}
                    className="cursor-pointer border-b last:border-0 hover:bg-accent"
                  >
                    <td className={cn(td, "font-mono text-xs")}>#{a.lotNumber}</td>
                    <td className={cn(td, "max-w-64 truncate font-medium")}>{a.title}</td>
                    <td className={td}>
                      <Pill value={a.status} />
                    </td>
                    <td className={td}>{a.category}</td>
                    <td className={cn(td, "text-xs")}>@{a.seller.handle}</td>
                    <td className={cn(td, "tabular")}>{fmtMoney(a.price)}</td>
                    <td className={cn(td, "tabular")}>{a.bidCount}</td>
                    <td className={cn(td, "text-xs")}>
                      {a.winner ? `@${a.winner.handle}` : "—"}
                      {a.order && (
                        <span className="block text-muted-foreground">
                          {a.order.orderNumber} · {a.order.status.toLowerCase().replace(/_/g, " ")}
                        </span>
                      )}
                    </td>
                    <td className={cn(td, "text-xs text-muted-foreground")}>{fmtDate(a.endsAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={q.data.page} total={q.data.total} limit={q.data.limit} onPage={setPage} />
        </>
      )}
      <Sheet open={!!openId} onOpenChange={(o) => !o && setOpenId(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          {openId && <AuctionDetail id={openId} access={access} />}
        </SheetContent>
      </Sheet>
    </Section>
  );
}

const CANCELLABLE = ["DRAFT", "PENDING_REVIEW", "SCHEDULED", "LIVE"];

function AuctionDetail({ id, access }: { id: string; access: AdminAccess }) {
  const q = useQuery({ queryKey: ["admin", "auction", id], queryFn: () => adminApi.auction(id) });
  const cancel = useAdminAction((reason: string) => adminApi.cancel(id, reason), {
    success: "Auction cancelled; bidders were notified",
    invalidate: [
      ["admin", "auction", id],
      ["admin", "auctions"],
      ["admin", "analytics"],
    ],
  });
  const confirm = useConfirm<true>();
  if (q.isPending) return <Loading rows={8} />;
  if (q.isError) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const a = q.data;
  return (
    <div className="space-y-6">
      <div>
        <SheetTitle>{a.title}</SheetTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          Lot #{a.lotNumber} · {a.category} · seller @{a.seller.handle} ({a.seller.email})
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Pill value={a.status} />
          <Link to="/room/$id" params={{ id: a.id }} className="text-xs underline">
            Open room
          </Link>
        </div>
        {a.cancelReason && <p className="mt-2 text-sm text-live">Cancelled: {a.cancelReason}</p>}
      </div>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        {[
          ["Start price", fmtMoney(a.startPrice)],
          ["Current / hammer", fmtMoney(a.price)],
          ["Reserve", a.reserve ? fmtMoney(a.reserve) : "None"],
          ["Bids", a.bidCount],
          ["Starts", fmtDate(a.startsAt)],
          ["Ends", fmtDate(a.endsAt)],
          ["Winner", a.winner ? `@${a.winner.handle} (${a.winner.email})` : "—"],
          [
            "Order",
            a.order
              ? `${a.order.orderNumber} · ${a.order.status.toLowerCase().replace(/_/g, " ")}${a.order.demoCompletedAt ? " · demo checkout done" : ""}`
              : "—",
          ],
        ].map(([k, v]) => (
          <div key={k as string} className="rounded-xl bg-secondary p-3">
            <dt className="text-xs text-muted-foreground">{k}</dt>
            <dd className="mt-0.5 break-words">{v}</dd>
          </div>
        ))}
      </dl>
      {access.moderateAuctions && CANCELLABLE.includes(a.status) && (
        <div>
          <button className={btnDanger} onClick={() => confirm.open(true)}>
            Cancel auction
          </button>
          <p className="mt-1 text-xs text-muted-foreground">
            Staff may cancel any listing before it ends. Bids are voided and every bidder is
            notified.
          </p>
        </div>
      )}
      <div>
        <p className="mb-2 text-sm font-medium">Bid history (staff view, real identities)</p>
        {a.bids.length === 0 ? (
          <p className="text-sm text-muted-foreground">No bids.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b">
              <tr>
                {["#", "Bidder", "Amount", "Network", "Time"].map((h) => (
                  <th key={h} className="px-2 py-2 text-left text-xs text-muted-foreground">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {a.bids.map((b) => (
                <tr key={b.id} className="border-b last:border-0">
                  <td className="px-2 py-2 tabular">{b.sequence}</td>
                  <td className="px-2 py-2">
                    @{b.bidder.handle}
                    <span className="block text-xs text-muted-foreground">{b.bidder.email}</span>
                  </td>
                  <td className="px-2 py-2 tabular">{fmtMoney(b.amount)}</td>
                  <td className="px-2 py-2 font-mono text-xs">{b.network ?? "—"}</td>
                  <td className="px-2 py-2 text-xs text-muted-foreground">
                    {fmtDate(b.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div>
        <p className="mb-2 text-sm font-medium">Lifecycle events</p>
        <ul className="divide-y rounded-lg border text-xs">
          {a.events.map((e) => (
            <li key={e.id} className="flex justify-between gap-3 p-2.5">
              <span className="font-mono">
                {e.type}
                {e.toStatus && ` → ${e.toStatus}`}
              </span>
              <span className="text-muted-foreground">{fmtDate(e.createdAt)}</span>
            </li>
          ))}
        </ul>
      </div>
      <ConfirmDialog
        {...confirm.props}
        title="Cancel this auction?"
        description="This cannot be undone. All bids become void and bidders are notified."
        reasonLabel="Reason (sent to the seller and bidders)"
        reasonRequired
        danger
        confirmLabel="Cancel auction"
        pending={cancel.isPending}
        onConfirm={(reason) => {
          confirm.close();
          cancel.mutate(reason);
        }}
      />
    </div>
  );
}
