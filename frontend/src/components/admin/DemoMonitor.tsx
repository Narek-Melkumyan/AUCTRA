import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmtFull } from "@/lib/auctions";
import { useRooms, type RoomState } from "@/lib/auction-store";
import { Countdown } from "@/components/auction/bits";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { AuctionImage } from "@/components/auction/AuctionImage";
import { photoOf } from "@/lib/media";

/** Demo-mode monitor (VITE_API_MODE=demo): drives off the in-browser simulation. */
const catData = [
  { c: "Cars", v: 3420 },
  { c: "Art", v: 2104 },
  { c: "Fashion", v: 1830 },
  { c: "Electr.", v: 1592 },
  { c: "Watches", v: 1286 },
  { c: "Jewelry", v: 967 },
];

export function DemoMonitor() {
  const rooms = Object.values(useRooms());
  const [filter, setFilter] = useState<"all" | "live" | "upcoming" | "ended">("all");
  const [inspect, setInspect] = useState<RoomState | null>(null);
  const list = rooms.filter((r) => filter === "all" || r.status === filter);
  const live = rooms.filter((r) => r.status === "live");
  return (
    <div className="mx-auto max-w-[1440px] px-4 py-10 sm:px-6 lg:px-10">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-primary">
        Admin · demo data
      </p>
      <h1 className="mt-2 font-display text-5xl sm:text-4xl">Live Auction Monitor</h1>
      <div className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[
          ["Live rooms", live.length],
          ["Total bids", rooms.reduce((a, r) => a + r.bids.length, 0)],
          ["Viewers online", live.reduce((a, r) => a + r.viewers, 0)],
          ["Live GMV", fmtFull(live.reduce((a, r) => a + r.currentBid, 0))],
        ].map(([l, v]) => (
          <div key={l as string} className="rounded-2xl border bg-card p-5">
            <p className="text-sm text-muted-foreground">{l}</p>
            <p className="mt-2 text-2xl font-semibold tabular sm:text-3xl">{v}</p>
          </div>
        ))}
      </div>
      <div className="mt-8 flex gap-2">
        {(["all", "live", "upcoming", "ended"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              "rounded-full border px-4 py-1.5 text-sm capitalize",
              filter === f && "border-primary bg-primary/10",
            )}
          >
            {f}
          </button>
        ))}
      </div>
      <div className="mt-4 overflow-x-auto rounded-2xl border bg-card">
        <table className="w-full min-w-[860px] text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr className="border-b">
              {[
                "Auction ID",
                "Item",
                "High bid",
                "Bids",
                "Bidders",
                "Viewers",
                "Remaining",
                "Status",
              ].map((h) => (
                <th key={h} className="px-4 py-3 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr
                key={r.id}
                onClick={() => setInspect(r)}
                className="cursor-pointer border-b last:border-0 hover:bg-accent"
              >
                <td className="px-4 py-3 font-mono text-xs">{r.id}</td>
                <td className="max-w-64 truncate px-4 py-3 font-medium">{r.title}</td>
                <td key={r.currentBid} className="animate-bump px-4 py-3 font-semibold tabular">
                  {fmtFull(r.currentBid)}
                </td>
                <td className="px-4 py-3 tabular">{r.bids.length}</td>
                <td className="px-4 py-3 tabular">{new Set(r.bids.map((b) => b.user)).size}</td>
                <td className="px-4 py-3 tabular">{r.viewers}</td>
                <td className="px-4 py-3">
                  <Countdown room={r} />
                </td>
                <td className="px-4 py-3">
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold capitalize",
                      r.status === "live"
                        ? "bg-live/15 text-live"
                        : r.status === "ended"
                          ? "bg-secondary text-muted-foreground"
                          : "bg-primary/15 text-primary",
                    )}
                  >
                    {r.status === "live" && (
                      <span className="size-1.5 rounded-full bg-live animate-live" />
                    )}
                    {r.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-8 rounded-2xl border bg-card p-5">
        <p className="font-semibold">Most popular categories</p>
        <div className="mt-4 h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={catData}>
              <CartesianGrid stroke="var(--border)" vertical={false} />
              <XAxis
                dataKey="c"
                stroke="var(--muted-foreground)"
                fontSize={12}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                stroke="var(--muted-foreground)"
                fontSize={12}
                tickLine={false}
                axisLine={false}
                width={40}
              />
              <Tooltip
                cursor={{ fill: "var(--accent)" }}
                contentStyle={{
                  background: "var(--popover)",
                  border: "1px solid var(--border)",
                  borderRadius: 12,
                }}
              />
              <Bar dataKey="v" fill="var(--chart-1)" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <Sheet open={!!inspect} onOpenChange={(o) => !o && setInspect(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md">
          {inspect &&
            (() => {
              const r = rooms.find((x) => x.id === inspect.id) ?? inspect;
              return (
                <>
                  <SheetTitle>{r.title}</SheetTitle>
                  <AuctionImage
                    photo={photoOf(r)}
                    size="card"
                    sizes="400px"
                    alt=""
                    className="mt-4 aspect-video w-full rounded-xl object-cover"
                  />
                  <dl className="mt-4 space-y-2 text-sm">
                    {[
                      ["Status", r.status],
                      ["High bid", fmtFull(r.currentBid)],
                      ["Reserve", r.reserve],
                      ["Seller", r.seller],
                    ].map(([k, v]) => (
                      <div key={k} className="flex justify-between">
                        <dt className="text-muted-foreground">{k}</dt>
                        <dd className="capitalize">{v}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="mb-2 mt-6 text-sm font-semibold">Latest bids</p>
                  {r.bids.slice(0, 8).map((b) => (
                    <div key={b.id} className="flex justify-between border-b py-2 text-sm">
                      <span>{b.mine ? "you" : b.user}</span>
                      <span className="tabular">{fmtFull(b.amount)}</span>
                    </div>
                  ))}
                  <Link
                    to="/room/$id"
                    params={{ id: r.id }}
                    className="mt-6 flex h-11 items-center justify-center rounded-xl bg-primary font-semibold text-primary-foreground"
                  >
                    Open room
                  </Link>
                </>
              );
            })()}
        </SheetContent>
      </Sheet>
    </div>
  );
}
