import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Send, Sparkles } from "lucide-react";

import { suggestedPrompts } from "@/lib/ai-mock";
import { services } from "@/services";
import { useRooms, type RoomState } from "@/lib/auction-store";
import { fmt } from "@/lib/auctions";
import { cn } from "@/lib/utils";
import { AuctionImage } from "@/components/auction/AuctionImage";
import { photoOf } from "@/lib/media";

type Msg = {
  role: "user" | "ai";
  text: string;
  items?: RoomState[];
};

type AiChatProps = {
  context?: RoomState;
  compact?: boolean;
};

export function AiChat({ context, compact = false }: AiChatProps) {
  const rooms = useRooms();

  const [msgs, setMsgs] = useState<Msg[]>([
    {
      role: "ai",
      text: context
        ? `Hi — I'm AUCTRA AI. Ask me anything about "${context.title}".`
        : "Hi — I'm AUCTRA AI, your personal auction expert. What are you looking for?",
    },
  ]);

  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);

  const endRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const pendingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
  }, [msgs, typing]);

  const ask = async (question: string) => {
    const q = question.trim();

    if (!q || pendingRef.current) return;

    pendingRef.current = true;
    setTyping(true);
    setInput("");

    setMsgs((prev) => [
      ...prev,
      {
        role: "user",
        text: q,
      },
    ]);

    try {
      const response = await services.ai.ask(q, Object.values(rooms), context);

      if (!mountedRef.current) return;

      const reply: Msg = {
        role: "ai",
        text: response.text,
        ...(response.items === undefined ? {} : { items: response.items }),
      };
      setMsgs((prev) => [...prev, reply]);
    } catch (error) {
      console.error("AI assistant error:", error);

      if (!mountedRef.current) return;

      setMsgs((prev) => [
        ...prev,
        {
          role: "ai",
          text: "The assistant is unavailable right now. Please try again.",
        },
      ]);
    } finally {
      pendingRef.current = false;

      if (mountedRef.current) {
        setTyping(false);
      }
    }
  };

  const prompts = context
    ? [
        "Explain the condition of this item",
        "What fees will I pay if I win?",
        "How much should I bid?",
        "Compare similar listings",
      ]
    : suggestedPrompts.slice(0, compact ? 4 : 6);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Messages */}
      <div
        className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
      >
        {msgs.map((message, index) => (
          <div key={index} className={cn("flex gap-2", message.role === "user" && "justify-end")}>
            {message.role === "ai" && (
              <div className="grid size-7 shrink-0 place-items-center rounded-md border bg-card text-muted-foreground">
                <Sparkles className="size-3.5" />
              </div>
            )}

            <div className="max-w-[85%] min-w-0 space-y-2">
              <div
                className={cn(
                  "whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm leading-relaxed",
                  message.role === "user" ? "bg-secondary" : "bg-transparent px-0",
                )}
              >
                {message.text}
              </div>

              {message.items?.slice(0, 3).map((room) => (
                <Link
                  key={room.id}
                  to="/item/$id"
                  params={{ id: String(room.id) }}
                  className="flex items-center gap-3 rounded-lg border bg-card p-2 transition hover:bg-accent"
                >
                  {room.images?.[0] ? (
                    <AuctionImage
                      photo={photoOf(room)}
                      size="thumb"
                      sizes="40px"
                      alt={room.title}
                      className="size-10 shrink-0 rounded-md object-cover"
                    />
                  ) : (
                    <div className="size-10 shrink-0 rounded-md bg-muted" />
                  )}

                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{room.title}</p>

                    <p className="text-xs text-muted-foreground tabular-nums">
                      {fmt(room.currentBid)} · {room.status}
                    </p>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        ))}

        {/* Typing indicator */}
        {typing && (
          <div className="flex gap-2" role="status">
            <div className="grid size-7 shrink-0 place-items-center rounded-md border bg-card text-muted-foreground">
              <Sparkles className="size-3.5" />
            </div>

            <div className="flex gap-1 rounded-lg px-1 py-3">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="size-1.5 animate-pulse rounded-full bg-muted-foreground"
                  style={{
                    animationDelay: `${i * 120}ms`,
                  }}
                />
              ))}
            </div>
            <span className="sr-only">Assistant is responding</span>
          </div>
        )}

        {/* Suggested prompts */}
        {msgs.length === 1 && (
          <div className="flex flex-wrap gap-2 pt-1">
            {prompts.map((prompt) => (
              <button
                key={prompt}
                type="button"
                disabled={typing}
                onClick={() => ask(prompt)}
                className="rounded-md border px-2.5 py-1 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-40"
              >
                {prompt}
              </button>
            ))}
          </div>
        )}

        <div ref={endRef} />
      </div>

      {/* Input */}
      <div className="border-t p-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void ask(input);
          }}
          className="flex items-center gap-2 rounded-md border bg-background px-3 focus-within:border-ring"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about lots, fees or bidding…"
            aria-label="Ask AUCTRA AI"
            disabled={typing}
            className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50"
          />

          <button
            type="submit"
            aria-label="Send message"
            disabled={!input.trim() || typing}
            className="grid size-7 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Send className="size-4" />
          </button>
        </form>

        <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
          Demo assistant. Suggestions are informational only and don't guarantee quality, value or
          outcomes. AI never places bids for you.
        </p>
      </div>
    </div>
  );
}
