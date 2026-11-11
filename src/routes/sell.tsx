import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Check, DollarSign, Eye, Gavel, Heart, Package, Plus, Upload } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { categories, fmt } from "@/lib/auctions";
import { useRooms } from "@/lib/auction-store";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/sell")({
  head: () => ({
    meta: [
      { title: "Seller Dashboard — AUCTRA" },
      { name: "description", content: "Manage listings, track bids and create new auctions on AUCTRA." },
      { property: "og:title", content: "Sell on AUCTRA" },
      { property: "og:description", content: "List anything from watches to real estate and reach global bidders." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Sell,
});

const chart = Array.from({ length: 14 }, (_, i) => ({ d: `D${i + 1}`, bids: Math.round(40 + 30 * Math.sin(i / 2) + i * 6) }));

function Sell() {
  const [wizard, setWizard] = useState(false);
  const rooms = Object.values(useRooms()).slice(0, 6);
  return (
    <div className="mx-auto max-w-[1440px] px-4 py-10 sm:px-6 lg:px-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div><p className="text-xs font-semibold uppercase tracking-[0.12em] text-primary">Seller dashboard · demo data</p><h1 className="mt-2 font-display text-5xl sm:text-4xl">Good evening, Riviera Motors</h1></div>
        <button onClick={() => setWizard(true)} className="inline-flex h-12 items-center gap-2 rounded-full bg-primary px-6 font-semibold text-primary-foreground hover:shadow-gold"><Plus className="size-4" /> Create listing</button>
      </div>
      {wizard ? <Wizard onClose={() => setWizard(false)} /> : (
        <>
          <div className="mt-10 grid grid-cols-2 gap-4 lg:grid-cols-4">
            {[[Package, "Active listings", "12"], [Check, "Completed sales", "184"], [DollarSign, "Revenue (90d)", "$1.84M"], [Gavel, "Pending payments", "3"]].map(([I, l, v]) => {
              const Icon = I as typeof Package;
              return <div key={l as string} className="rounded-2xl border bg-card p-5"><Icon className="size-5 text-primary" /><p className="mt-4 text-3xl font-semibold">{v as string}</p><p className="text-sm text-muted-foreground">{l as string}</p></div>;
            })}
          </div>
          <div className="mt-6 rounded-2xl border bg-card p-5">
            <p className="font-semibold">Bid activity</p><p className="text-sm text-muted-foreground">Last 14 days</p>
            <div className="mt-4 h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chart}>
                  <defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.4} /><stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} /></linearGradient></defs>
                  <CartesianGrid stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="d" stroke="var(--muted-foreground)" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis stroke="var(--muted-foreground)" fontSize={12} tickLine={false} axisLine={false} width={32} />
                  <Tooltip contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 12 }} />
                  <Area type="monotone" dataKey="bids" stroke="var(--chart-1)" strokeWidth={2} fill="url(#g)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="mt-6 overflow-x-auto rounded-2xl border bg-card">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-muted-foreground"><tr className="border-b">{["Listing", "Status", "Current bid", "Bids", "Views", "Watching", ""].map((h) => <th key={h} className="px-5 py-3 font-medium">{h}</th>)}</tr></thead>
              <tbody>
                {rooms.map((r) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="px-5 py-3"><div className="flex items-center gap-3"><img src={r.images[0]} alt="" className="size-10 rounded-lg object-cover" /><span className="font-medium">{r.title}</span></div></td>
                    <td className="px-5 py-3 capitalize">{r.status}</td>
                    <td className="px-5 py-3 font-semibold tabular">{fmt(r.currentBid)}</td>
                    <td className="px-5 py-3 tabular">{r.bids.length}</td>
                    <td className="px-5 py-3 tabular"><Eye className="mr-1 inline size-3.5" />{(r.watchers * 7).toLocaleString()}</td>
                    <td className="px-5 py-3 tabular"><Heart className="mr-1 inline size-3.5" />{r.watchers}</td>
                    <td className="px-5 py-3"><Link to="/room/$id" params={{ id: r.id }} className="text-primary">Open room</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

const steps = ["Category", "Item info", "Photos", "Condition", "Pricing", "Schedule", "Shipping", "Preview"];

function Wizard({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState(0);
  const [d, setD] = useState({ category: "", title: "", description: "", photos: 0, condition: "", start: "", reserve: "", startAt: "", endAt: "", shipping: "" });
  const [err, setErr] = useState("");
  const validate = (): string => {
    if (s === 0 && !d.category) return "Choose a category.";
    if (s === 1 && d.title.trim().length < 5) return "Title must be at least 5 characters.";
    if (s === 2 && d.photos < 1) return "Add at least one photo.";
    if (s === 3 && !d.condition) return "Select a condition.";
    if (s === 4 && !(Number(d.start) > 0)) return "Enter a starting bid.";
    if (s === 4 && d.reserve && Number(d.reserve) < Number(d.start)) return "Reserve can't be below the starting bid.";
    if (s === 5 && (!d.startAt || !d.endAt || d.endAt <= d.startAt)) return "End time must be after start time.";
    if (s === 6 && !d.shipping) return "Choose a shipping option.";
    return "";
  };
  const next = () => { const e = validate(); setErr(e); if (!e) s === 7 ? (toast.success("Listing submitted for review (demo)"), onClose()) : setS(s + 1); };
  const input = "h-12 w-full rounded-xl border bg-background px-4 outline-none focus:border-primary";
  const choice = (on: boolean) => cn("rounded-xl border px-4 py-3 text-left text-sm transition", on ? "border-primary bg-primary/10" : "hover:border-primary/40");

  return (
    <div className="mx-auto mt-10 max-w-3xl rounded-3xl border bg-card p-6 sm:p-10">
      <div className="mb-8 flex items-center gap-1.5">{steps.map((st, i) => <div key={st} className={cn("h-1.5 flex-1 rounded-full", i <= s ? "bg-primary" : "bg-secondary")} />)}</div>
      <p className="text-xs uppercase tracking-widest text-muted-foreground">Step {s + 1} of 8</p>
      <h2 className="mb-6 font-display text-4xl">{steps[s]}</h2>
      {s === 0 && <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{categories.map((c) => <button key={c.name} onClick={() => setD({ ...d, category: c.name })} className={choice(d.category === c.name)}>{c.name}</button>)}</div>}
      {s === 1 && <div className="space-y-3"><input className={input} placeholder="Listing title" value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} /><textarea className={cn(input, "h-32 py-3")} placeholder="Description" value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} /></div>}
      {s === 2 && <button onClick={() => setD({ ...d, photos: d.photos + 1 })} className="grid w-full place-items-center rounded-2xl border border-dashed py-16 text-muted-foreground hover:border-primary"><Upload className="size-8" /><span className="mt-3">Click to add a photo (demo) — {d.photos} added</span></button>}
      {s === 3 && <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">{["New", "Excellent", "Very Good", "Good", "Fair"].map((c) => <button key={c} onClick={() => setD({ ...d, condition: c })} className={choice(d.condition === c)}>{c}</button>)}</div>}
      {s === 4 && <div className="grid gap-3 sm:grid-cols-2"><input className={input} inputMode="numeric" placeholder="Starting bid ($)" value={d.start} onChange={(e) => setD({ ...d, start: e.target.value.replace(/\D/g, "") })} /><input className={input} inputMode="numeric" placeholder="Reserve price (optional)" value={d.reserve} onChange={(e) => setD({ ...d, reserve: e.target.value.replace(/\D/g, "") })} /></div>}
      {s === 5 && <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm text-muted-foreground">Start<input type="datetime-local" className={cn(input, "mt-1")} value={d.startAt} onChange={(e) => setD({ ...d, startAt: e.target.value })} /></label><label className="text-sm text-muted-foreground">End<input type="datetime-local" className={cn(input, "mt-1")} value={d.endAt} onChange={(e) => setD({ ...d, endAt: e.target.value })} /></label></div>}
      {s === 6 && <div className="grid gap-2 sm:grid-cols-3">{["Buyer pickup", "Seller ships", "White-glove"].map((c) => <button key={c} onClick={() => setD({ ...d, shipping: c })} className={choice(d.shipping === c)}>{c}</button>)}</div>}
      {s === 7 && <dl className="grid gap-px overflow-hidden rounded-2xl border bg-border text-sm sm:grid-cols-2">{[["Category", d.category], ["Title", d.title], ["Photos", String(d.photos)], ["Condition", d.condition], ["Starting bid", `$${Number(d.start).toLocaleString()}`], ["Reserve", d.reserve ? `$${Number(d.reserve).toLocaleString()}` : "None"], ["Schedule", `${d.startAt} → ${d.endAt}`], ["Shipping", d.shipping]].map(([k, v]) => <div key={k} className="bg-card p-4"><dt className="text-muted-foreground">{k}</dt><dd className="font-medium">{v}</dd></div>)}</dl>}
      {err && <p className="mt-4 text-sm text-live">{err}</p>}
      <div className="mt-8 flex justify-between">
        <button onClick={() => (s === 0 ? onClose() : setS(s - 1))} className="h-12 rounded-xl border px-6 font-semibold">{s === 0 ? "Cancel" : "Back"}</button>
        <button onClick={next} className="h-12 rounded-xl bg-primary px-6 font-semibold text-primary-foreground">{s === 7 ? "Publish" : "Continue"}</button>
      </div>
    </div>
  );
}
