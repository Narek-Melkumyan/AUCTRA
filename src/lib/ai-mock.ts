/**
 * Placeholder AUCTRA AI responder using local demo data. Replace `askAssistant`
 * with a call to a real AI backend later. It never places bids.
 */
import { buyerFees, fmtFull } from "./auctions";
import type { RoomState } from "./auction-store";

export type AiReply = { text: string; items?: RoomState[] };

export const suggestedPrompts = [
  "Find luxury watches under $15,000",
  "Which live auctions are ending soon?",
  "Explain how bidding works",
  "What fees will I pay if I win?",
  "Show me auctions with no reserve",
  "How much should I bid?",
];

export function askAssistant(q: string, rooms: RoomState[], context?: RoomState): AiReply {
  const t = q.toLowerCase();
  const live = rooms.filter((r) => r.status === "live");
  const num = Number((t.match(/\$?\s?([\d,]+)\s?k?/)?.[1] ?? "").replace(/,/g, "")) * (/\d\s?k\b/.test(t) ? 1000 : 1);

  if (t.includes("watch")) {
    const items = rooms.filter((r) => r.category === "Luxury Watches" && (!num || r.currentBid <= num));
    return { text: items.length ? `I found ${items.length} watch listing${items.length > 1 ? "s" : ""}${num ? ` currently under ${fmtFull(num)}` : ""}:` : "No watches match that budget right now. Try saving a search to be alerted.", items };
  }
  if (t.includes("ending") || t.includes("soon")) {
    const items = [...live].sort((a, b) => a.endsAt - b.endsAt).slice(0, 3);
    return { text: "These live auctions close next:", items };
  }
  if (t.includes("reserve")) {
    const items = rooms.filter((r) => r.reserve === "none");
    return { text: `${items.length} lots have no reserve — the highest bid wins when the timer ends.`, items };
  }
  if (t.includes("fee")) {
    const base = context?.currentBid ?? 10000;
    const f = buyerFees(base);
    return { text: `On a winning bid of ${fmtFull(base)} (demo fee model): buyer's premium 10% = ${fmtFull(f.premium)} (capped at $25,000), plus a ${fmtFull(f.platform)} platform fee. Estimated total ${fmtFull(f.total)} before shipping and taxes.` };
  }
  if (t.includes("how") && t.includes("bid") && !t.includes("much")) {
    return { text: "1) Register and verify your identity. 2) Join a live room. 3) Bid at least the minimum next bid shown — bids move in fixed increments. 4) A bid in the final 10 seconds extends the clock to 10 seconds. 5) If you're highest when it closes and the reserve is met, you win and proceed to checkout." };
  }
  if (t.includes("much") || t.includes("should i bid")) {
    const r = context ?? live[0];
    return { text: r ? `For "${r.title}", the current bid is ${fmtFull(r.currentBid)} with ${r.bids.length} bids. Set a firm maximum before bidding, include fees in your budget, and compare recent sales from independent sources. I can't predict the final price.` : "Set a maximum budget including fees before you bid." };
  }
  if (t.includes("condition") && context) {
    return { text: `Seller-reported condition: ${context.condition}. ${context.inspection} Always review photos and request an independent inspection where possible.` };
  }
  if (t.includes("compare")) {
    const items = live.filter((r) => r.category === (context?.category ?? "Cars & Vehicles")).slice(0, 2);
    return { text: items.length > 1 ? "Here are two comparable live lots side by side:" : "There's only one comparable live lot right now. Here it is:", items };
  }
  return { text: context ? `I can help with "${context.title}" — ask about its condition, fees, or how bidding works.` : "I can find items, explain bidding and fees, or show what's ending soon. Try one of the suggestions." };
}
