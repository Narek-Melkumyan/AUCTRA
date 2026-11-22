import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { buyerFees, fmtFull } from "@/lib/auctions";
import { IS_API_MODE } from "@/lib/auction-store";
import { useCheckoutTerms } from "@/lib/api/checkout";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

export const Route = createFileRoute("/how-it-works")({
  head: () => ({
    meta: [
      { title: "How It Works, Fees & Rules — AUCTRA" },
      {
        name: "description",
        content: "How bidding works on AUCTRA, buyer fees, auction rules and FAQ.",
      },
      { property: "og:title", content: "How AUCTRA Works" },
      {
        property: "og:description",
        content: "Discover, verify, bid and win — plus a fee calculator.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: How,
});

function How() {
  const [amt, setAmt] = useState("25000");
  const terms = useCheckoutTerms(IS_API_MODE);
  const hammer = Number(amt) || 0;
  const pct = (terms.data?.buyerPremiumBps ?? 0) / 100;
  // API mode: the server's configured buyer premium, no platform fee.
  const f = IS_API_MODE
    ? (() => {
        const premium = Math.round((hammer * pct) / 100);
        return { premium, platform: 0, total: hammer + premium };
      })()
    : buyerFees(hammer);
  return (
    <div className="mx-auto max-w-5xl px-4 py-14 sm:px-6">
      <h1 className="font-display text-5xl sm:text-7xl">
        How It <span className="italic text-gold-gradient">Works</span>
      </h1>
      <ol className="mt-12 grid gap-4 sm:grid-cols-2">
        {[
          ["Discover", "Search and filter lots across every category, or ask AUCTRA AI."],
          IS_API_MODE
            ? [
                "Register & Verify",
                "Create an account and verify your email before your first bid.",
              ]
            : ["Register & Verify", "Create an account and complete a one-time identity check."],
          IS_API_MODE
            ? [
                "Place Your Bid",
                "Join a live room. Bids move in fixed increments and every bidder sees them instantly; listings with anti-sniping extend the clock after a late bid.",
              ]
            : [
                "Place Your Bid",
                "Join a live room. Bids move in fixed increments; a bid in the last 10 seconds extends the clock.",
              ],
          IS_API_MODE
            ? [
                "Win & Checkout",
                "If you're highest at close and the reserve is met, an order is created and you complete the simulated checkout — no payment is taken.",
              ]
            : [
                "Win & Checkout",
                "If you're highest at close and reserve is met, pay securely and arrange delivery.",
              ],
        ].map(([t, d], i) => (
          <li key={t} className="rounded-2xl border bg-card p-6">
            <span className="font-display text-4xl text-primary">0{i + 1}</span>
            <p className="mt-3 text-lg font-semibold">{t}</p>
            <p className="mt-1 text-muted-foreground">{d}</p>
          </li>
        ))}
      </ol>
      <section className="mt-16 rounded-3xl border bg-surface p-6 sm:p-10">
        <h2 className="font-display text-4xl">Fee calculator</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {IS_API_MODE
            ? `Buyer's premium ${terms.isPending ? "…" : `${pct}%`} of the hammer price, as configured by AUCTRA. No platform fee.`
            : "Demo fee model: 10% buyer's premium (max $25,000) + $49 platform fee."}
        </p>
        <div className="mt-6 grid gap-6 sm:grid-cols-2">
          <label className="text-sm text-muted-foreground">
            Winning bid ($)
            <input
              inputMode="numeric"
              value={amt}
              onChange={(e) => setAmt(e.target.value.replace(/\D/g, ""))}
              className="mt-1 h-12 w-full rounded-xl border bg-background px-4 text-lg text-foreground outline-none focus:border-primary"
            />
          </label>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Buyer's premium</span>
              <span className="tabular">{fmtFull(f.premium)}</span>
            </div>
            {!IS_API_MODE && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Platform fee</span>
                <span className="tabular">{fmtFull(f.platform)}</span>
              </div>
            )}
            <div className="flex justify-between border-t pt-2 text-lg font-semibold">
              <span>Total</span>
              <span className="tabular">{fmtFull(f.total)}</span>
            </div>
          </div>
        </div>
      </section>
      <section className="mt-16">
        <h2 className="mb-4 font-display text-4xl">FAQ & rules</h2>
        <Accordion type="single" collapsible>
          {(
            [
              [
                "Are bids binding?",
                "Yes. On the live platform every bid is a binding commitment to buy at that price if you win.",
              ],
              [
                "What is a reserve?",
                "A confidential minimum price. If bidding doesn't reach it, the seller isn't obliged to sell.",
              ],
              IS_API_MODE
                ? [
                    "What is anti-sniping?",
                    "Sellers can enable it per listing: a bid in the final window pushes the end time back so everyone can respond. Without it, auctions end exactly on time and late bids are rejected.",
                  ]
                : [
                    "What is soft close?",
                    "Any bid in the final 10 seconds resets the clock to 10 seconds, so everyone gets a fair chance.",
                  ],
              IS_API_MODE
                ? [
                    "Is this real?",
                    "Listings, bids, chat, notifications and orders are real records on the AUCTRA server. Checkout is simulated: no card is collected and no money moves.",
                  ]
                : [
                    "Is this demo real?",
                    "No. Listings, bids, timers and statistics here are simulated locally to demonstrate the interface.",
                  ],
              ["Privacy & terms", "Full privacy policy and terms will be published before launch."],
            ] as const
          ).map(([q, a]) => (
            <AccordionItem key={q} value={q}>
              <AccordionTrigger className="text-base">{q}</AccordionTrigger>
              <AccordionContent className="text-muted-foreground">{a}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </section>
    </div>
  );
}
