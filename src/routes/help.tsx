import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { toast } from "sonner";
import { btn, input, metaFor } from "@/components/account/AccountLayout";
import { buyerFees, fmtFull } from "@/lib/auctions";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/help")({
  head: () => ({ meta: metaFor("Help center", "Answers about bidding, fees, payments, shipping and selling on AUCTRA.") }),
  component: Help,
});

const ex = buyerFees(10000);
const faqs: { topic: string; q: string; a: string }[] = [
  { topic: "Bidding", q: "How do bid increments work?", a: "Each lot has a fixed increment shown in the room. Your bid must be at least the current bid plus one increment, in whole increments." },
  { topic: "Bidding", q: "What happens if someone bids in the final seconds?", a: "A bid placed in the last 10 seconds resets the clock to 10 seconds so every bidder has a fair chance to respond." },
  { topic: "Bidding", q: "Can I retract a bid?", a: "Bids are binding. Contact support immediately if you made an error — retractions are reviewed case by case." },
  { topic: "Fees", q: "What fees will I pay?", a: `A 10% buyer's premium (capped at $25,000) plus a $49 platform fee. On a ${fmtFull(10000)} hammer price you'd pay ${fmtFull(ex.total)} before delivery.` },
  { topic: "Payments", q: "When do I pay?", a: "After an auction closes, the winner has 3 business days to complete checkout." },
  { topic: "Shipping", q: "How is my item delivered?", a: "Choose buyer pickup, insured shipping or white-glove delivery at checkout. Options depend on the lot." },
  { topic: "Selling", q: "How do I list an item?", a: "Open the seller dashboard and use Create listing. Listings are reviewed before going live." },
  { topic: "Account", q: "Why do I need to verify my identity?", a: "Verification protects sellers and bidders and is required before your first bid." },
];
const topics = ["All", ...Array.from(new Set(faqs.map((f) => f.topic)))];

function Help() {
  const [q, setQ] = useState("");
  const [t, setT] = useState("All");
  const [open, setOpen] = useState<number | null>(0);
  const rows = faqs.filter((f) => (t === "All" || f.topic === t) && `${f.q} ${f.a}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-medium tracking-tight">Help center</h1>
      <p className="mt-2 text-sm text-muted-foreground">Fees and rules shown are demo placeholders until confirmed.</p>
      <div className="relative mt-6"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search help articles" className={cn(input, "pl-9")} aria-label="Search help" /></div>
      <div className="mt-4 flex flex-wrap gap-1">{topics.map((x) => <button key={x} onClick={() => setT(x)} className={cn("rounded-md px-3 py-1.5 text-sm", t === x ? "bg-accent" : "text-muted-foreground hover:text-foreground")}>{x}</button>)}</div>
      <ul className="mt-6 divide-y rounded-lg border bg-card">
        {rows.map((f, i) => (
          <li key={f.q}>
            <button onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i} className="flex w-full items-center justify-between gap-4 p-4 text-left text-sm font-medium">{f.q}<span className="text-muted-foreground">{open === i ? "−" : "+"}</span></button>
            {open === i && <p className="px-4 pb-4 text-sm text-muted-foreground">{f.a}</p>}
          </li>
        ))}
        {rows.length === 0 && <li className="p-6 text-center text-sm text-muted-foreground">No articles match. Try the <Link to="/assistant" className="underline">assistant</Link>.</li>}
      </ul>
      <form onSubmit={(e) => { e.preventDefault(); (e.currentTarget as HTMLFormElement).reset(); toast.success("Message received (demo) — nothing was sent."); }} className="mt-12 space-y-3 rounded-lg border bg-card p-5">
        <h2 className="text-sm font-medium">Still need help?</h2>
        <input required type="email" placeholder="Your email" className={input} aria-label="Email" />
        <textarea required rows={4} placeholder="How can we help?" className={cn(input, "h-auto py-2")} aria-label="Message" />
        <button className={btn}>Send message</button>
      </form>
    </div>
  );
}
