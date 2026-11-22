import { useEffect, useState } from "react";
import { toast } from "sonner";
import { loadPreferences, savePreferences, type PreferenceRow } from "@/services/api";
import { cn } from "@/lib/utils";

const LABELS: Record<string, string> = {
  OUTBID: "Outbid",
  NEW_BID: "New bids on my listings",
  AUCTION_STARTED: "Watched auction started",
  AUCTION_ENDING_SOON: "Watched auction ending soon",
  AUCTION_REMINDER: "My reminders",
  AUCTION_WON: "Auction won",
  AUCTION_LOST: "Auction lost",
  AUCTION_SOLD: "My lot sold",
  AUCTION_UNSOLD: "My lot didn't sell",
  AUCTION_APPROVED: "Listing approved",
  AUCTION_REJECTED: "Listing needs changes",
  CHAT_MESSAGE: "Chat activity in my auctions",
  DIRECT_MESSAGE: "New messages from buyers and sellers",
  ORDER_UPDATE: "Order updates",
  ANNOUNCEMENT: "AUCTRA announcements",
  SYSTEM: "Other platform notices",
  ACCOUNT_SECURITY: "Security alerts",
};

function Switch({
  on,
  disabled,
  label,
  onChange,
}: {
  on: boolean;
  disabled?: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={cn(
        "relative h-5 w-9 rounded-full transition disabled:cursor-not-allowed disabled:opacity-50",
        on ? "bg-primary" : "bg-muted",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 size-4 rounded-full bg-background transition",
          on ? "left-[18px]" : "left-0.5",
        )}
      />
    </button>
  );
}

/** Per-type in-app / email switches (API mode). Security alerts are always on. */
export function NotificationPreferences() {
  const [rows, setRows] = useState<PreferenceRow[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    loadPreferences()
      .then(setRows)
      .catch(() => setError(true));
  }, []);

  const toggle = async (row: PreferenceRow) => {
    const next = { type: row.type, channel: row.channel, enabled: !row.enabled };
    setRows(
      (r) =>
        r?.map((x) =>
          x.type === row.type && x.channel === row.channel ? { ...x, enabled: next.enabled } : x,
        ) ?? r,
    );
    try {
      setRows(await savePreferences([next]));
    } catch {
      toast.error("Could not save that preference.");
      setRows(
        (r) => r?.map((x) => (x.type === row.type && x.channel === row.channel ? row : x)) ?? r,
      );
    }
  };

  if (error)
    return <p className="text-sm text-muted-foreground">Couldn't load notification preferences.</p>;
  if (!rows)
    return (
      <div className="h-48 animate-pulse rounded-lg border bg-muted/40" aria-label="Loading" />
    );
  const types = [...new Set(rows.map((r) => r.type))];
  const find = (type: string, channel: string) =>
    rows.find((r) => r.type === type && r.channel === channel)!;
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <table className="w-full text-sm">
        <thead className="border-b text-xs text-muted-foreground">
          <tr>
            <th className="p-3 text-left font-medium">Notify me about</th>
            <th className="w-20 p-3 font-medium">In-app</th>
            <th className="w-20 p-3 font-medium">Email</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {types.map((type) => (
            <tr key={type}>
              <td className="p-3">
                {LABELS[type] ?? type}
                {find(type, "IN_APP").locked && (
                  <span className="ml-2 text-xs text-muted-foreground">always on</span>
                )}
              </td>
              {(["IN_APP", "EMAIL"] as const).map((ch) => {
                const r = find(type, ch);
                return (
                  <td key={ch} className="p-3 text-center">
                    <Switch
                      on={r.enabled}
                      disabled={r.locked}
                      label={`${LABELS[type] ?? type}: ${ch === "EMAIL" ? "email" : "in-app"}`}
                      onChange={() => void toggle(r)}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t p-3 text-xs text-muted-foreground">
        Emails are only sent to verified addresses, never for alerts you've already read in the app,
        and at most a few per hour.
      </p>
    </div>
  );
}
