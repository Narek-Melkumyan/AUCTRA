import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { adminApi, fmtMoney, type AdminAccess } from "@/lib/api/admin";
import { cn } from "@/lib/utils";
import {
  EmptyRow,
  ErrorState,
  Loading,
  Pill,
  Section,
  StatCard,
  card,
  select,
  td,
  th,
} from "./shared";

const axis = { stroke: "var(--muted-foreground)", fontSize: 12, tickLine: false, axisLine: false };
const tooltip = {
  cursor: { fill: "var(--accent)" },
  contentStyle: {
    background: "var(--popover)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    fontSize: 12,
  },
};
const shortDay = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

export function OverviewPanel({ access }: { access: AdminAccess }) {
  const [days, setDays] = useState(30);
  const q = useQuery({
    queryKey: ["admin", "analytics", days],
    queryFn: () => adminApi.analytics(days),
    enabled: access.analytics,
    refetchInterval: 30_000,
  });
  const flags = useQuery({
    queryKey: ["admin", "integrity"],
    queryFn: () => adminApi.integrity(30),
    enabled: access.analytics && access.auctions,
  });

  if (!access.analytics)
    return <EmptyRow>Analytics need the analytics:read permission (administrators).</EmptyRow>;
  if (q.isPending) return <Loading rows={6} />;
  if (q.isError) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const a = q.data;
  const t = a.totals;
  const pct = (x: number) => `${Math.round(x * 100)}%`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Live from PostgreSQL · updated {new Date(a.generatedAt).toLocaleTimeString()}
        </p>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Period
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className={select}>
            {[7, 30, 90].map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Total users"
          value={t.users.toLocaleString()}
          hint={`${t.verifiedUsers} verified · +${t.newUsers} new`}
        />
        <StatCard
          label="Active users (7d)"
          value={t.activeUsers7d.toLocaleString()}
          hint={`${t.activeUsers24h} in the last 24h`}
        />
        <StatCard
          label="Active auctions"
          value={(t.liveAuctions + t.scheduledAuctions).toLocaleString()}
          hint={`${t.liveAuctions} live · ${t.scheduledAuctions} scheduled · ${t.pendingReview} in review`}
        />
        <StatCard
          label="Completed auctions"
          value={t.completedAuctions.toLocaleString()}
          hint={`${t.soldAuctions} sold · ${t.unsoldAuctions} unsold`}
        />
        <StatCard
          label="Total bids"
          value={t.bids.toLocaleString()}
          hint={`${t.bidsInPeriod} in period · ${t.activeBidders} bidders`}
        />
        <StatCard
          label="Demo checkouts completed"
          value={`${a.checkout.demoCompleted} / ${a.checkout.ordersTotal}`}
          hint={`${pct(a.checkout.completionRate)} completion · simulated, no real payments`}
        />
        <StatCard
          label="Chat messages"
          value={t.chatMessages.toLocaleString()}
          hint={`in the last ${a.periodDays} days`}
        />
        <StatCard
          label="Needs attention"
          value={t.openReports + t.pendingSellers + t.pendingReview}
          hint={`${t.openReports} reports · ${t.pendingSellers} seller apps · ${t.pendingReview} listings`}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className={cn(card, "p-5")}>
          <p className="font-semibold">Bids over time</p>
          <div className="mt-4 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={a.bidsOverTime}>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="day" tickFormatter={shortDay} {...axis} minTickGap={24} />
                <YAxis {...axis} width={32} allowDecimals={false} />
                <Tooltip {...tooltip} labelFormatter={(d) => shortDay(String(d))} />
                <Area
                  type="monotone"
                  dataKey="bids"
                  name="Bids"
                  stroke="var(--chart-1)"
                  fill="var(--chart-1)"
                  fillOpacity={0.2}
                />
                <Area
                  type="monotone"
                  dataKey="bidders"
                  name="Bidders"
                  stroke="var(--chart-2)"
                  fill="var(--chart-2)"
                  fillOpacity={0.1}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className={cn(card, "p-5")}>
          <p className="font-semibold">New registrations</p>
          <div className="mt-4 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={a.registrationsOverTime}>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="day" tickFormatter={shortDay} {...axis} minTickGap={24} />
                <YAxis {...axis} width={32} allowDecimals={false} />
                <Tooltip {...tooltip} labelFormatter={(d) => shortDay(String(d))} />
                <Bar dataKey="users" name="Sign-ups" fill="var(--chart-3)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className={cn(card, "p-5")}>
          <p className="font-semibold">Auction categories</p>
          <div className="mt-4 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={a.categories}>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="name" {...axis} interval={0} tick={{ fontSize: 11 }} />
                <YAxis {...axis} width={32} allowDecimals={false} />
                <Tooltip {...tooltip} />
                <Bar
                  dataKey="auctions"
                  name="Auctions"
                  fill="var(--chart-1)"
                  radius={[4, 4, 0, 0]}
                />
                <Bar dataKey="bids" name="Bids" fill="var(--chart-2)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className={cn(card, "p-5")}>
          <p className="font-semibold">Demo checkout funnel</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Simulated transactions only — AUCTRA never takes real payments.
          </p>
          <dl className="mt-4 space-y-3 text-sm">
            {Object.entries(a.checkout.byStatus).length === 0 && (
              <p className="text-muted-foreground">
                No orders yet. Orders appear when an auction sells.
              </p>
            )}
            {Object.entries(a.checkout.byStatus).map(([status, count]) => (
              <div key={status}>
                <div className="flex justify-between">
                  <dt>
                    <Pill value={status} />
                  </dt>
                  <dd className="tabular">{count}</dd>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-muted">
                  <div
                    className="h-1.5 rounded-full bg-primary"
                    style={{ width: `${(count / Math.max(1, a.checkout.ordersTotal)) * 100}%` }}
                  />
                </div>
              </div>
            ))}
            {a.salesVolume.map((v) => (
              <div key={v.hammer.currency} className="flex justify-between border-t pt-3">
                <dt className="text-muted-foreground">Hammer volume ({v.hammer.currency})</dt>
                <dd className="tabular">
                  {fmtMoney(v.hammer)} · {v.orders} orders
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      <Section
        title="Most active auctions"
        description="By bid count, with bidders and chat activity."
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b">
              <tr>
                {["Auction", "Status", "Price", "Bids", "Bidders", "Chat", "Ends"].map((h) => (
                  <th key={h} className={th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {a.mostActiveAuctions.map((x) => (
                <tr key={x.id} className="border-b last:border-0">
                  <td className={cn(td, "max-w-72 truncate font-medium")}>
                    <Link to="/room/$id" params={{ id: x.id }} className="hover:underline">
                      {x.title}
                    </Link>
                  </td>
                  <td className={td}>
                    <Pill value={x.status} />
                  </td>
                  <td className={cn(td, "tabular")}>{fmtMoney(x.price)}</td>
                  <td className={cn(td, "tabular")}>{x.bidCount}</td>
                  <td className={cn(td, "tabular")}>{x.bidders}</td>
                  <td className={cn(td, "tabular")}>{x.chatMessages}</td>
                  <td className={cn(td, "text-muted-foreground")}>
                    {new Date(x.endsAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {access.auctions && (
        <Section
          title="Bid integrity signals"
          description="Patterns worth a human look (shared networks, seller affinity, bursts). Signals are not proof — nothing is actioned automatically."
        >
          {flags.isPending ? (
            <Loading rows={2} />
          ) : flags.isError ? (
            <ErrorState error={flags.error} retry={() => void flags.refetch()} />
          ) : flags.data.length === 0 ? (
            <EmptyRow>No suspicious bidding patterns in the last 30 days.</EmptyRow>
          ) : (
            <ul className="divide-y">
              {flags.data.map((f, i) => (
                <li key={i} className="flex flex-wrap items-start gap-3 px-5 py-3 text-sm">
                  <Pill value={f.severity} />
                  <div className="min-w-0 flex-1">
                    <p>{f.summary}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {f.kind.replace(/_/g, " ").toLowerCase()} · accounts:{" "}
                      {f.users.map((u) => `@${u.handle ?? u.id.slice(0, 8)}`).join(", ")}
                    </p>
                  </div>
                  {f.auctionId && (
                    <Link to="/room/$id" params={{ id: f.auctionId }} className="text-xs underline">
                      Open auction
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
    </div>
  );
}
