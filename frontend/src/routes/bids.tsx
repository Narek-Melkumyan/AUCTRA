import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AccountLayout, Empty, btn, metaFor } from "@/components/account/AccountLayout";
import { Countdown } from "@/components/auction/bits";
import { IS_API_MODE, isWonByMe, useRooms, type RoomState } from "@/lib/auction-store";
import { fmt } from "@/lib/auctions";
import { cn } from "@/lib/utils";
import { AuctionImage } from "@/components/auction/AuctionImage";
import { photoOf } from "@/lib/media";

export const Route = createFileRoute("/bids")({
  head: () => ({
    meta: metaFor("My bids", "Track every auction you've bid on — leading, outbid, won and lost."),
  }),
  component: Bids,
});

const state = (r: RoomState) => {
  if (r.status === "ended") return isWonByMe(r) ? "won" : "lost";
  return r.bids[0]?.mine ? "leading" : "outbid";
};
const tabs = ["all", "leading", "outbid", "won", "lost"] as const;

function Bids() {
  const [tab, setTab] = useState<(typeof tabs)[number]>("all");
  const mine = Object.values(useRooms()).filter((r) => r.bids.some((b) => b.mine));
  const rows = mine.filter((r) => tab === "all" || state(r) === tab);
  return (
    <AccountLayout
      title="My bids"
      description={
        IS_API_MODE
          ? "Every auction you have bid on, with your position from the server."
          : "Demo data from bids placed in this browser."
      }
    >
      <div className="mb-4 flex flex-wrap gap-1" role="tablist">
        {tabs.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm capitalize",
              tab === t
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t}{" "}
            <span className="tabular text-xs text-muted-foreground">
              {t === "all" ? mine.length : mine.filter((r) => state(r) === t).length}
            </span>
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <Empty
          title="Nothing here"
          body={
            mine.length
              ? "No bids match this filter."
              : IS_API_MODE
                ? "Place a bid in any live room to start tracking it."
                : "Place a demo bid in any live room to start tracking it."
          }
          action={
            <Link to="/live" className={btn}>
              Go to live auctions
            </Link>
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b text-left text-xs text-muted-foreground">
              <tr>
                <th className="p-3 font-normal">Lot</th>
                <th className="p-3 font-normal">Status</th>
                <th className="p-3 text-right font-normal">Your highest bid</th>
                <th className="p-3 text-right font-normal">Current</th>
                <th className="p-3 text-right font-normal">Time left</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((r) => {
                const s = state(r);
                const my = Math.max(...r.bids.filter((b) => b.mine).map((b) => b.amount));
                return (
                  <tr key={r.id}>
                    <td className="p-3">
                      <Link
                        to="/item/$id"
                        params={{ id: r.id }}
                        className="flex items-center gap-3 hover:underline underline-offset-4"
                      >
                        <AuctionImage
                          photo={photoOf(r)}
                          size="thumb"
                          sizes="36px"
                          alt=""
                          className="size-9 rounded-md object-cover"
                        />
                        <span className="max-w-[220px] truncate">{r.title}</span>
                      </Link>
                    </td>
                    <td
                      className={cn(
                        "p-3 capitalize",
                        s === "leading" || s === "won" ? "text-success" : "text-live",
                      )}
                    >
                      {s === "lost" && r.bids[0]?.mine && r.reserve === "not-met"
                        ? "Reserve not met"
                        : s}
                    </td>
                    <td className="p-3 text-right tabular">{fmt(my)}</td>
                    <td className="p-3 text-right tabular">{fmt(r.currentBid)}</td>
                    <td className="p-3 text-right">
                      <Countdown room={r} className="text-muted-foreground" />
                    </td>
                    <td className="p-3 text-right">
                      {s === "won" ? (
                        <Link
                          to="/checkout/$id"
                          params={{ id: r.id }}
                          className="text-sm font-medium hover:underline"
                        >
                          Checkout
                        </Link>
                      ) : r.status === "live" ? (
                        <Link
                          to="/room/$id"
                          params={{ id: r.id }}
                          className="text-sm font-medium hover:underline"
                        >
                          {s === "outbid" ? "Bid again" : "Open room"}
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </AccountLayout>
  );
}
