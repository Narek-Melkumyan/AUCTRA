import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { History, Plus, Send, ShieldAlert, Sparkles, Square, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog, useConfirm } from "@/components/admin/shared";
import { useSession } from "@/lib/demo-session";
import { getRoomsSnapshot } from "@/lib/auction-store";
import { mediaUrl } from "@/lib/api/adapters";
import { adminApi } from "@/lib/api/admin";
import { ApiError } from "@/lib/api/client";
import {
  aiApi,
  streamChat,
  type AiMessage,
  type AiScope,
  type ListingCard,
  type ProposedAction,
} from "@/lib/api/ai";
import { cn } from "@/lib/utils";
import { SafeMarkdown } from "./SafeMarkdown";
import { photoOf } from "@/lib/media";

const USER_PROMPTS = [
  "Find me live BMW auctions under $50,000",
  "Which watches are ending soonest?",
  "How does bidding work here?",
  "What does 'reserve not met' mean?",
  "How does the demo checkout work?",
  "Show upcoming real-estate auctions",
];
const CONTEXT_PROMPTS = [
  "Summarise this listing",
  "What's the minimum next bid?",
  "Is the reserve met?",
  "When does it end?",
];
const ADMIN_PROMPTS = [
  "Write an operational report for the last 30 days",
  "Are there any suspicious bidding patterns?",
  "Summarise open moderation reports and suggest actions",
  "Which auctions perform best and why?",
  "Explain the demo checkout completion rate",
];

/**
 * Server-backed assistant (OpenAI Responses API via the AUCTRA API).
 * `scope="admin"` uses the separate admin assistant with its own tools and permissions.
 */
export function AssistantChat({
  scope = "user",
  auctionId,
  compact = false,
}: {
  scope?: AiScope;
  auctionId?: string;
  compact?: boolean;
}) {
  const user = useSession((s) => s.user);
  const restored = useSession((s) => s.restored);
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ["ai", "status", scope, user?.id ?? null],
    queryFn: () => aiApi.status(scope),
    enabled: restored,
  });
  const history = useQuery({
    queryKey: ["ai", "conversations", scope, user?.id ?? null],
    queryFn: () => aiApi.conversations(scope),
    enabled: !!user && !!status.data?.allowed,
  });
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [toolLabel, setToolLabel] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [messages, toolLabel]);
  useEffect(() => () => abort.current?.abort(), []);

  const maxChars = status.data?.maxInputChars ?? 2000;

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    if (q.length > maxChars) {
      toast.error(`Please keep questions under ${maxChars} characters.`);
      return;
    }
    setInput("");
    setBusy(true);
    setToolLabel(null);
    const userMsg: AiMessage = { id: `u-${Date.now()}`, role: "USER", content: q };
    const pendingId = `a-${Date.now()}`;
    setMessages((m) => [...m, userMsg, { id: pendingId, role: "ASSISTANT", content: "" }]);
    const update = (fn: (m: AiMessage) => AiMessage) =>
      setMessages((list) => list.map((m) => (m.id === pendingId ? fn(m) : m)));
    abort.current = new AbortController();
    try {
      await streamChat(
        scope,
        {
          message: q,
          ...(conversationId ? { conversationId } : {}),
          ...(auctionId ? { auctionId } : {}),
        },
        {
          onMeta: (id) => setConversationId(id),
          onTool: (label) => setToolLabel(label),
          onDelta: (t) => {
            setToolLabel(null);
            update((m) => ({ ...m, content: m.content + t }));
          },
          onDone: (d) => {
            update((m) => ({
              ...m,
              id: d.messageId,
              content: d.text,
              ...(d.listings.length ? { listings: d.listings } : {}),
              ...(d.proposals.length ? { proposals: d.proposals } : {}),
            }));
            void qc.invalidateQueries({ queryKey: ["ai"] });
          },
          onError: (message) => update((m) => ({ ...m, content: message, error: true })),
        },
        abort.current.signal,
      );
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        update((m) => ({ ...m, content: m.content || "Stopped." }));
      } else {
        update((m) => ({
          ...m,
          content:
            err instanceof ApiError ? err.message : "The assistant is unavailable right now.",
          error: true,
        }));
        void status.refetch();
      }
    } finally {
      setBusy(false);
      setToolLabel(null);
      abort.current = null;
    }
  };

  const openConversation = async (id: string) => {
    try {
      setMessages(await aiApi.conversation(id));
      setConversationId(id);
    } catch {
      toast.error("Couldn't open that conversation.");
    }
  };

  // ── gating states
  const s = status.data;
  let gate: ReactNode = null;
  if (!restored || status.isPending)
    gate = <p className="p-6 text-sm text-muted-foreground">Loading assistant…</p>;
  else if (status.isError)
    gate = <Notice title="Assistant unavailable" body="Couldn't reach the AUCTRA API." />;
  else if (s && !s.configured)
    gate = (
      <Notice
        title="AI assistant not configured"
        body="This server has no OpenAI API key (OPENAI_API_KEY), so the assistant is switched off. No answers are simulated."
      />
    );
  else if (s?.requiresSignIn || !user)
    gate = (
      <Notice
        title="Sign in to use the assistant"
        body="The assistant is available to signed-in members (usage is limited per account)."
      >
        <Link
          to="/login"
          className="mt-4 inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
        >
          Sign in
        </Link>
      </Notice>
    );
  else if (s && s.allowed === false)
    gate = (
      <Notice title="Not available" body="Your account doesn't have access to this assistant." />
    );

  const prompts = scope === "admin" ? ADMIN_PROMPTS : auctionId ? CONTEXT_PROMPTS : USER_PROMPTS;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
        <Sparkles className="size-3.5 text-primary" />
        <span className="font-medium text-foreground">
          {scope === "admin" ? "Admin assistant" : "AUCTRA assistant"}
        </span>
        {s?.usage && (
          <span className="hidden sm:inline">
            · {Math.round(s.usage.remainingToday / 1000)}k tokens left today
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {!gate && (history.data?.length ?? 0) > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="Previous conversations"
                className="rounded p-1.5 hover:bg-accent"
              >
                <History className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-80 w-72 overflow-y-auto">
                {history.data!.map((c) => (
                  <DropdownMenuItem
                    key={c.id}
                    className="flex justify-between gap-2"
                    onSelect={() => void openConversation(c.id)}
                  >
                    <span className="truncate">{c.title}</span>
                    <button
                      aria-label="Delete conversation"
                      className="shrink-0 rounded p-0.5 hover:bg-background"
                      onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        void aiApi.remove(c.id).then(() => {
                          if (c.id === conversationId) {
                            setMessages([]);
                            setConversationId(undefined);
                          }
                          void qc.invalidateQueries({ queryKey: ["ai", "conversations"] });
                        });
                      }}
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {!gate && messages.length > 0 && (
            <button
              aria-label="New conversation"
              disabled={busy}
              onClick={() => {
                setMessages([]);
                setConversationId(undefined);
              }}
              className="rounded p-1.5 hover:bg-accent disabled:opacity-40"
            >
              <Plus className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" role="log" aria-live="polite">
        {gate ?? (
          <>
            {messages.length === 0 && (
              <div>
                <p className="text-sm text-muted-foreground">
                  {scope === "admin"
                    ? "Ask for reports, trends or a review of the moderation queue. I use read-only tools and can only suggest actions — you confirm them."
                    : auctionId
                      ? "Ask anything about this listing. I read live data from AUCTRA and never bid for you."
                      : "Hi — I can search live and upcoming auctions, explain bidding and statuses, and guide you around AUCTRA."}
                </p>
                <div className={cn("mt-3 flex flex-wrap gap-2", compact && "gap-1.5")}>
                  {prompts.slice(0, compact ? 4 : 6).map((p) => (
                    <button
                      key={p}
                      onClick={() => void ask(p)}
                      className="rounded-md border px-2.5 py-1 text-left text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground"
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m) => (
              <Message key={m.id} m={m} busy={busy} />
            ))}
            {toolLabel && (
              <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
                <span className="size-1.5 animate-pulse rounded-full bg-primary" />
                {toolLabel}…
              </p>
            )}
            <div ref={end} />
          </>
        )}
      </div>

      {!gate && (
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
              maxLength={maxChars}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                scope === "admin"
                  ? "Ask about platform data…"
                  : "Ask about lots, bidding or checkout…"
              }
              aria-label="Ask the assistant"
              disabled={busy}
              className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50"
            />
            {busy ? (
              <button
                type="button"
                aria-label="Stop"
                onClick={() => abort.current?.abort()}
                className="grid size-7 shrink-0 place-items-center rounded-md border"
              >
                <Square className="size-3.5" />
              </button>
            ) : (
              <button
                type="submit"
                aria-label="Send message"
                disabled={!input.trim()}
                className="grid size-7 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground disabled:opacity-40"
              >
                <Send className="size-4" />
              </button>
            )}
          </form>
          <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
            {scope === "admin"
              ? "AI analysis can be wrong. Suggested actions are never executed until you confirm them."
              : "AI answers can be wrong; listings and prices come from AUCTRA's database. The assistant never places bids."}
          </p>
        </div>
      )}
    </div>
  );
}

function Notice({ title, body, children }: { title: string; body: string; children?: ReactNode }) {
  return (
    <div className="m-2 rounded-lg border border-dashed p-5 text-center text-sm">
      <ShieldAlert className="mx-auto size-6 text-muted-foreground" aria-hidden />
      <p className="mt-2 font-medium">{title}</p>
      <p className="mt-1 text-muted-foreground">{body}</p>
      {children}
    </div>
  );
}

function Message({ m, busy }: { m: AiMessage; busy: boolean }) {
  if (m.role === "USER")
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-secondary px-3 py-2 text-sm">
          {m.content}
        </p>
      </div>
    );
  return (
    <div className="flex gap-2">
      <div className="grid size-7 shrink-0 place-items-center rounded-md border bg-card text-muted-foreground">
        <Sparkles className="size-3.5" />
      </div>
      <div className="min-w-0 max-w-[90%] flex-1 space-y-2">
        {m.content ? (
          <div className={cn("space-y-1.5 text-sm leading-relaxed", m.error && "text-live")}>
            <SafeMarkdown text={m.content} />
          </div>
        ) : (
          busy && (
            <div className="flex gap-1 py-3">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="size-1.5 animate-pulse rounded-full bg-muted-foreground"
                  style={{ animationDelay: `${i * 120}ms` }}
                />
              ))}
            </div>
          )
        )}
        {m.listings?.map((l) => (
          <ListingCardView key={l.id} l={l} />
        ))}
        {m.proposals?.map((p, i) => (
          <ProposalCard key={i} p={p} />
        ))}
      </div>
    </div>
  );
}

function ListingCardView({ l }: { l: ListingCard }) {
  const room = getRoomsSnapshot()[l.id];
  const img = (room ? photoOf(room)?.thumb : undefined) ?? (l.image ? mediaUrl(l.image, "") : null);
  const isRoom = l.link.startsWith("/room/");
  const params = { id: l.id };
  const inner = (
    <>
      {img ? (
        <img src={img} alt="" className="size-11 shrink-0 rounded-md object-cover" loading="lazy" />
      ) : (
        <div className="size-11 shrink-0 rounded-md bg-muted" />
      )}
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{l.title}</p>
        <p className="text-xs text-muted-foreground tabular-nums">
          {l.formattedPrice} · {l.phase} · {l.bidCount} bids · {l.category}
        </p>
      </div>
    </>
  );
  const cls = "flex items-center gap-3 rounded-lg border bg-card p-2 transition hover:bg-accent";
  return isRoom ? (
    <Link to="/room/$id" params={params} className={cls}>
      {inner}
    </Link>
  ) : (
    <Link to="/item/$id" params={params} className={cls}>
      {inner}
    </Link>
  );
}

const ACTION_LABEL: Record<ProposedAction["action"], string> = {
  suspend_user: "Suspend account",
  ban_user: "Ban account",
  mute_chat: "Mute in chat (1h)",
  ban_chat: "Ban from chat",
  hide_message: "Hide chat message",
  cancel_auction: "Cancel auction",
};

/** An action the admin assistant suggested. It only runs if the admin confirms it here. */
function ProposalCard({ p }: { p: ProposedAction }) {
  const confirm = useConfirm<true>();
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const qc = useQueryClient();
  const run = async (reason: string) => {
    setState("busy");
    try {
      const r = reason || p.reason;
      switch (p.action) {
        case "suspend_user":
          await adminApi.suspend(p.targetId, r, "SUSPENDED");
          break;
        case "ban_user":
          await adminApi.suspend(p.targetId, r, "BANNED");
          break;
        case "mute_chat":
          await adminApi.restrict(p.targetId, "MUTE", 60, r);
          break;
        case "ban_chat":
          await adminApi.restrict(p.targetId, "BAN", undefined, r, true);
          break;
        case "hide_message":
          await adminApi.moderateMessage(p.targetId, "hide", r);
          break;
        case "cancel_auction":
          await adminApi.cancel(p.targetId, r);
          break;
      }
      setState("done");
      toast.success("Action applied and audit-logged");
      void qc.invalidateQueries({ queryKey: ["admin"] });
    } catch (err) {
      setState("idle");
      toast.error(err instanceof ApiError ? err.message : "Action failed.");
    }
  };
  return (
    <div className="rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-primary">
        Suggested action · not executed
      </p>
      <p className="mt-1 font-medium">
        {ACTION_LABEL[p.action]}: {p.targetLabel}
      </p>
      <p className="mt-0.5 text-muted-foreground">{p.reason}</p>
      <button
        disabled={state !== "idle"}
        onClick={() => confirm.open(true)}
        className="mt-2 inline-flex h-8 items-center rounded-md border bg-background px-3 text-xs font-medium hover:bg-accent disabled:opacity-50"
      >
        {state === "done" ? "Applied" : state === "busy" ? "Applying…" : "Review & confirm"}
      </button>
      <ConfirmDialog
        {...confirm.props}
        title={`${ACTION_LABEL[p.action]}?`}
        description={`Target: ${p.targetLabel}. This runs with your own permissions and is recorded in the audit log.`}
        reasonLabel="Reason (edit if needed)"
        danger={p.action !== "mute_chat" && p.action !== "hide_message"}
        confirmLabel="Confirm action"
        onConfirm={(reason) => {
          confirm.close();
          void run(reason);
        }}
      />
    </div>
  );
}
