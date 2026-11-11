import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Send, Sparkles } from "lucide-react";
import { askAssistant, suggestedPrompts, type AiReply } from "@/lib/ai-mock";
import { useRooms, type RoomState } from "@/lib/auction-store";
import { fmt } from "@/lib/auctions";
import { cn } from "@/lib/utils";

type Msg = { role: "user" | "ai"; text: string; items?: RoomState[] };

export function AiChat({ context, compact }: { context?: RoomState; compact?: boolean }) {
  const rooms = useRooms();
  const [msgs, setMsgs] = useState<Msg[]>([
    { role: "ai", text: context ? `Hi — I'm AUCTRA AI. Ask me anything about "${context.title}".` : "Hi — I'm AUCTRA AI, your personal auction expert. What are you looking for?" },
  ]);
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), [msgs, typing]);

  const ask = (q: string) => {
    if (!q.trim() || typing) return;
    setMsgs((m) => [...m, { role: "user", text: q }]);
    setInput("");
    setTyping(true);
    setTimeout(() => {
      const r: AiReply = askAssistant(q, Object.values(rooms), context);
      setMsgs((m) => [...m, { role: "ai", ...r }]);
      setTyping(false);
    }, 700);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {msgs.map((m, i) => (
          <div key={i} className={cn("flex gap-2", m.role === "user" && "justify-end")}>
            {m.role === "ai" && (
              <div className="grid size-7 shrink-0 place-items-center rounded-md border bg-card text-muted-foreground"><Sparkles className="size-3.5" /></div>
            )}
            <div className="max-w-[85%] space-y-2">
              <div className={cn("rounded-lg px-3 py-2 text-sm leading-relaxed", m.role === "user" ? "bg-secondary" : "bg-transparent px-0")}>{m.text}</div>
              {m.items?.slice(0, 3).map((r) => (
                <Link key={r.id} to="/item/$id" params={{ id: r.id }} className="flex items-center gap-3 rounded-lg border bg-card p-2 transition hover:bg-accent">
                  <img src={r.images[0]} alt="" className="size-10 rounded-md object-cover" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{r.title}</p>
                    <p className="text-xs text-muted-foreground tabular">{fmt(r.currentBid)} · {r.status}</p>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        ))}
        {typing && (
          <div className="flex gap-2">
            <div className="grid size-7 place-items-center rounded-md border bg-card text-muted-foreground"><Sparkles className="size-3.5" /></div>
            <div className="flex gap-1 rounded-lg px-1 py-3">
              {[0, 1, 2].map((i) => <span key={i} className="size-1.5 animate-pulse rounded-full bg-muted-foreground" style={{ animationDelay: `${i * 120}ms` }} />)}
            </div>
          </div>
        )}
        {msgs.length === 1 && (
          <div className="flex flex-wrap gap-2 pt-1">
            {(context ? ["Explain the condition of this item", "What fees will I pay if I win?", "How much should I bid?", "Compare similar listings"] : suggestedPrompts.slice(0, compact ? 4 : 6)).map((p) => (
              <button key={p} onClick={() => ask(p)} className="rounded-md border px-2.5 py-1 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground">{p}</button>
            ))}
          </div>
        )}
        <div ref={end} />
      </div>
      <div className="border-t p-3">
        <form onSubmit={(e) => { e.preventDefault(); ask(input); }} className="flex items-center gap-2 rounded-md border bg-background px-3 focus-within:border-ring">
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about lots, fees or bidding…" className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
          <button aria-label="Send" className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground disabled:opacity-40" disabled={!input.trim()}><Send className="size-4" /></button>
        </form>
        <p className="mt-2 text-[11px] leading-snug text-muted-foreground">Demo assistant. Suggestions are informational only and don't guarantee quality, value or outcomes. AI never places bids for you.</p>
      </div>
    </div>
  );
}
