import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, MessageSquare, Send } from "lucide-react";
import { AccountLayout, Empty, btn, metaFor } from "@/components/account/AccountLayout";
import { IS_API_MODE } from "@/lib/auction-store";
import { useSession } from "@/lib/demo-session";
import { ApiError } from "@/lib/api/client";
import { mediaUrl } from "@/lib/api/adapters";
import { onSocketEvent } from "@/lib/api/live";
import {
  messagesApi,
  type ConversationSummary,
  type DirectMessage,
  type MessageEvent,
} from "@/lib/api/messages";
import { cn } from "@/lib/utils";

type Search = { c?: string | undefined };

export const Route = createFileRoute("/messages")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    c: typeof s["c"] === "string" && /^[0-9a-f-]{36}$/.test(s["c"]) ? s["c"] : undefined,
  }),
  head: () => ({
    meta: metaFor("Messages", "Conversations between buyers and sellers about a listing."),
  }),
  component: Messages,
});

const errText = (e: unknown) =>
  e instanceof ApiError ? e.message : "Something went wrong. Please try again.";
const time = (iso: string) => {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
};

function Messages() {
  const user = useSession((s) => s.user);
  const restored = useSession((s) => s.restored);
  const { c } = Route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();

  // Live updates: refresh the inbox when any message for me arrives.
  useEffect(() => {
    if (!user) return;
    return onSocketEvent("message", () => {
      void qc.invalidateQueries({ queryKey: ["messages", "list"] });
      void qc.invalidateQueries({ queryKey: ["messages", "unread"] });
    });
  }, [user, qc]);

  const list = useQuery({
    queryKey: ["messages", "list", user?.id],
    queryFn: () => messagesApi.list(1),
    enabled: IS_API_MODE && Boolean(user),
  });

  if (!IS_API_MODE)
    return (
      <AccountLayout title="Messages">
        <Empty
          title="Messaging needs the AUCTRA server"
          body="Buyer–seller messages are stored on the server, so they are not available in the offline demo."
        />
      </AccountLayout>
    );
  if (!restored)
    return (
      <AccountLayout title="Messages">
        <div className="h-64 animate-pulse rounded-lg bg-muted/40" />
      </AccountLayout>
    );
  if (!user)
    return (
      <AccountLayout title="Messages">
        <Empty
          title="Sign in to see your messages"
          body="Ask sellers about a lot, or answer questions about your listings."
          action={
            <Link to="/login" className={btn}>
              Sign in
            </Link>
          }
        />
      </AccountLayout>
    );

  const items = list.data?.items ?? [];
  const open = (id: string | undefined) =>
    void navigate({ to: "/messages", search: id ? { c: id } : {}, replace: false });

  return (
    <AccountLayout
      title="Messages"
      description="Private conversations with buyers and sellers about a specific lot."
    >
      {list.isPending ? (
        <div className="h-64 animate-pulse rounded-lg bg-muted/40" />
      ) : list.isError ? (
        <p className="rounded-lg border p-6 text-sm text-live">{errText(list.error)}</p>
      ) : items.length === 0 ? (
        <Empty
          title="No conversations yet"
          body="Open any lot and use “Message the seller” to ask a question."
          action={
            <Link to="/explore" className={btn}>
              Browse auctions
            </Link>
          }
        />
      ) : (
        <div className="grid min-h-[560px] overflow-hidden rounded-xl border bg-card md:grid-cols-[320px_1fr]">
          <ul
            aria-label="Conversations"
            className={cn("divide-y overflow-y-auto border-r md:block", c && "hidden")}
          >
            {items.map((x) => (
              <ConversationRow key={x.id} c={x} active={x.id === c} onOpen={() => open(x.id)} />
            ))}
          </ul>
          <div className={cn("min-w-0", !c && "hidden md:block")}>
            {c ? (
              <ThreadView key={c} id={c} onBack={() => open(undefined)} />
            ) : (
              <div className="grid h-full place-items-center p-10 text-center text-sm text-muted-foreground">
                <div>
                  <MessageSquare className="mx-auto mb-3 size-8 opacity-60" />
                  Select a conversation
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </AccountLayout>
  );
}

function ConversationRow({
  c,
  active,
  onOpen,
}: {
  c: ConversationSummary;
  active: boolean;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        onClick={onOpen}
        aria-current={active ? "true" : undefined}
        className={cn(
          "flex w-full items-start gap-3 p-3 text-left transition hover:bg-accent",
          active && "bg-accent",
        )}
      >
        {c.auction?.image ? (
          <img
            src={mediaUrl(c.auction.image, "")}
            alt=""
            loading="lazy"
            className="size-11 shrink-0 rounded-md object-cover"
          />
        ) : (
          <div className="size-11 shrink-0 rounded-md bg-muted" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <p className={cn("truncate text-sm", c.unread ? "font-semibold" : "font-medium")}>
              {c.counterpart?.displayName ?? "Member"}
            </p>
            <span className="rounded bg-secondary px-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {c.myRole === "seller" ? "buyer" : "seller"}
            </span>
            {c.lastMessage && (
              <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                {time(c.lastMessage.createdAt)}
              </span>
            )}
          </div>
          <p className="truncate text-xs text-muted-foreground">{c.auction?.title ?? c.subject}</p>
          <p
            className={cn(
              "mt-0.5 truncate text-xs",
              c.unread ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {c.lastMessage
              ? `${c.lastMessage.mine ? "You: " : ""}${c.lastMessage.body ?? "Message removed"}`
              : ""}
          </p>
        </div>
        {c.unread > 0 && (
          <span
            className="mt-1 grid min-w-5 place-items-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground"
            aria-label={`${c.unread} unread`}
          >
            {c.unread}
          </span>
        )}
      </button>
    </li>
  );
}

function ThreadView({ id, onBack }: { id: string; onBack: () => void }) {
  const qc = useQueryClient();
  const user = useSession((s) => s.user);
  const q = useInfiniteQuery({
    queryKey: ["messages", "thread", id],
    queryFn: ({ pageParam }) => messagesApi.thread(id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.messages[0]?.id : undefined),
  });
  const [live, setLive] = useState<DirectMessage[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const head = q.data?.pages[0];

  const messages = useMemo(() => {
    const older = [...(q.data?.pages ?? [])].reverse().flatMap((p) => p.messages);
    const seen = new Set(older.map((m) => m.id));
    return [...older, ...live.filter((m) => !seen.has(m.id))];
  }, [q.data, live]);

  const markRead = () =>
    messagesApi
      .read(id)
      .then(() => {
        void qc.invalidateQueries({ queryKey: ["messages", "list"] });
        void qc.invalidateQueries({ queryKey: ["messages", "unread"] });
      })
      .catch(() => undefined);

  // Opening the thread marks it read.
  useEffect(() => {
    if (head) void markRead();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [head?.id]);

  // New messages in this thread arrive over Socket.IO.
  useEffect(
    () =>
      onSocketEvent("message", (e) => {
        const ev = e as MessageEvent;
        if (ev.conversationId !== id) return;
        setLive((cur) =>
          cur.some((m) => m.id === ev.message.id)
            ? cur
            : [
                ...cur,
                {
                  id: ev.message.id,
                  mine: ev.message.senderId === user?.id,
                  body: ev.message.body,
                  hidden: false,
                  createdAt: ev.message.createdAt,
                },
              ],
        );
        if (ev.message.senderId !== user?.id) void markRead();
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, user?.id],
  );

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  const lastMine = [...messages].reverse().find((m) => m.mine);
  const seen = lastMine && head?.counterpartReadAt && head.counterpartReadAt >= lastMine.createdAt;

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError("");
    try {
      const m = await messagesApi.send(id, body);
      setLive((cur) => (cur.some((x) => x.id === m.id) ? cur : [...cur, m]));
      setText("");
      void qc.invalidateQueries({ queryKey: ["messages", "list"] });
    } catch (err) {
      setError(errText(err));
    } finally {
      setSending(false);
    }
  };

  if (q.isPending)
    return (
      <div className="grid h-full place-items-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading" />
      </div>
    );
  if (q.isError) return <p className="p-6 text-sm text-live">{errText(q.error)}</p>;

  return (
    <div className="flex h-[560px] flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <button
          onClick={onBack}
          aria-label="Back to conversations"
          className="grid size-8 place-items-center rounded-md hover:bg-accent md:hidden"
        >
          <ArrowLeft className="size-4" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">
            {head?.counterpart?.displayName ?? "Member"}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {head?.myRole === "seller" ? "Buyer" : "Seller"}
            </span>
          </p>
          {head?.auction && (
            <Link
              to="/item/$id"
              params={{ id: head.auction.id }}
              className="block truncate text-xs text-muted-foreground hover:text-foreground"
            >
              {head.auction.title}
            </Link>
          )}
        </div>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto px-4 py-4" aria-live="polite">
        {q.hasNextPage && (
          <div className="text-center">
            <button
              onClick={() => void q.fetchNextPage()}
              disabled={q.isFetchingNextPage}
              className="text-xs text-muted-foreground underline-offset-4 hover:underline"
            >
              {q.isFetchingNextPage ? "Loading…" : "Load earlier messages"}
            </button>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={cn("flex", m.mine ? "justify-end" : "justify-start")}>
            <div
              className={cn(
                "max-w-[78%] rounded-2xl px-3.5 py-2 text-sm",
                m.mine ? "bg-primary text-primary-foreground" : "bg-secondary",
              )}
            >
              <p className={cn("whitespace-pre-wrap break-words", m.hidden && "italic opacity-70")}>
                {m.body ?? "Message removed by a moderator"}
              </p>
              <p
                className={cn(
                  "mt-0.5 text-[10px]",
                  m.mine ? "text-primary-foreground/70" : "text-muted-foreground",
                )}
              >
                {time(m.createdAt)}
              </p>
            </div>
          </div>
        ))}
        {seen && <p className="text-right text-[11px] text-muted-foreground">Seen</p>}
        <div ref={bottom} />
      </div>
      <form
        className="border-t p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {error && <p className="mb-2 text-xs text-live">{error}</p>}
        <div className="flex items-end gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            maxLength={4000}
            placeholder="Write a message…"
            aria-label="Message"
            className="max-h-32 min-h-10 flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-ring"
          />
          <button
            className={cn(btn, "size-10 px-0")}
            disabled={!text.trim() || sending}
            aria-label="Send message"
          >
            {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          </button>
        </div>
      </form>
    </div>
  );
}
