import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { EyeOff, Flag, MoreHorizontal, Pin, Send, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSession } from "@/lib/demo-session";
import { CHAT_MAX, useAuctionChat, type ChatMessage, type ChatViewer } from "@/lib/api/chat";
import { cn } from "@/lib/utils";

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Server-backed auction room chat (API mode). Message bodies are rendered as text only. */
export function LiveChat({ auctionId }: { auctionId: string }) {
  const user = useSession((s) => s.user);
  const chat = useAuctionChat(auctionId, user?.handle);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [auto, setAuto] = useState(true);
  const end = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (auto) end.current?.scrollIntoView({ block: "nearest" });
  }, [chat.messages.length, auto]);

  const submit = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    const r = await chat.send(text);
    setSending(false);
    if (r.ok) {
      setDraft((current) => (current.trim() === text ? "" : current));
      setAuto(true);
    } else toast.error(r.error);
  };

  const mod = chat.viewer?.isModerator ?? false;

  return (
    <>
      <div className="flex gap-2 border-b bg-primary/5 px-4 py-2.5 text-xs text-muted-foreground">
        <Pin className="mt-0.5 size-3.5 shrink-0 text-primary" />
        Room chat is public and moderated. Be respectful — never share contact or payment details.
      </div>
      <div
        ref={scroller}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4"
        role="log"
        aria-live="polite"
        aria-label="Auction chat"
        onScroll={(e) => {
          const el = e.currentTarget;
          setAuto(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
        }}
      >
        {chat.hasMore && (
          <button
            onClick={() =>
              void chat.loadOlder().catch(() => toast.error("Couldn't load older messages."))
            }
            className="mx-auto block rounded-full border px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Load earlier messages
          </button>
        )}
        {chat.loading && (
          <div className="space-y-3" aria-label="Loading chat">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-10 w-2/3 animate-pulse rounded-2xl bg-muted/60" />
            ))}
          </div>
        )}
        {!chat.loading && chat.error && (
          <p className="p-6 text-center text-sm text-muted-foreground">
            {chat.error}{" "}
            <button className="underline" onClick={() => void chat.retry()}>
              Retry
            </button>
          </p>
        )}
        {!chat.loading && !chat.error && chat.messages.length === 0 && (
          <p className="p-8 text-center text-sm text-muted-foreground">
            No messages yet. Say hello to the room.
          </p>
        )}
        {chat.messages.map((m) => (
          <Message key={m.id} m={m} mod={mod} chat={chat} />
        ))}
        <div ref={end} />
      </div>
      <Composer
        viewer={chat.viewer}
        draft={draft}
        setDraft={setDraft}
        sending={sending}
        onSubmit={() => void submit()}
      />
    </>
  );
}

function Message({
  m,
  mod,
  chat,
}: {
  m: ChatMessage;
  mod: boolean;
  chat: ReturnType<typeof useAuctionChat>;
}) {
  const hidden = m.status !== "VISIBLE";
  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>, done: string) => {
    const r = await fn();
    if (r.ok) toast.success(done);
    else toast.error(r.error ?? "Failed.");
  };
  return (
    <div className={cn("group flex flex-col", m.mine && "items-end")}>
      <p className="mb-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
        <span className="font-medium">{m.mine ? "You" : `@${m.author.handle}`}</span>
        {m.author.isSeller && (
          <span className="rounded bg-primary/15 px-1 text-[10px] text-primary">SELLER</span>
        )}
        {m.author.isStaff && (
          <span className="inline-flex items-center gap-0.5 rounded bg-success/15 px-1 text-[10px] text-success">
            <ShieldCheck className="size-2.5" />
            STAFF
          </span>
        )}
        <span>· {time(m.createdAt)}</span>
        {hidden && (
          <span className="inline-flex items-center gap-0.5 rounded bg-live/15 px-1 text-[10px] text-live">
            <EyeOff className="size-2.5" />
            {m.status}
          </span>
        )}
        {!m.mine && (
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="Message actions"
              className="ml-1 rounded p-0.5 opacity-0 hover:bg-accent focus:opacity-100 group-hover:opacity-100"
            >
              <MoreHorizontal className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="text-sm">
              {["Spam", "Harassment", "Scam or fraud", "Off-topic"].map((reason) => (
                <DropdownMenuItem
                  key={reason}
                  onSelect={() =>
                    void chat
                      .report(m.id, reason)
                      .then((r) =>
                        r.ok
                          ? toast.success(
                              r.duplicate ? "Already reported" : "Reported to moderators",
                            )
                          : toast.error(r.error),
                      )
                  }
                >
                  <Flag className="mr-2 size-3.5" /> Report: {reason}
                </DropdownMenuItem>
              ))}
              {mod && (
                <>
                  <DropdownMenuSeparator />
                  {m.status === "VISIBLE" ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        void act(() => chat.moderate(m.id, "hide", "Hidden by moderator"), "Hidden")
                      }
                    >
                      Hide message
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem
                      onSelect={() => void act(() => chat.moderate(m.id, "restore"), "Restored")}
                    >
                      Restore message
                    </DropdownMenuItem>
                  )}
                  {m.status !== "DELETED" && (
                    <DropdownMenuItem
                      onSelect={() =>
                        void act(
                          () => chat.moderate(m.id, "delete", "Removed by moderator"),
                          "Deleted",
                        )
                      }
                    >
                      Delete message
                    </DropdownMenuItem>
                  )}
                  {m.authorId && !m.author.isStaff && (
                    <>
                      <DropdownMenuItem
                        onSelect={() =>
                          void act(() => chat.restrict(m.authorId!, "MUTE", 15), "Muted for 15 min")
                        }
                      >
                        Mute author 15 min
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-live"
                        onSelect={() => {
                          if (confirm(`Ban @${m.author.handle} from all auction chats?`))
                            void act(() => chat.restrict(m.authorId!, "BAN"), "Banned from chat");
                        }}
                      >
                        Ban author from chat
                      </DropdownMenuItem>
                    </>
                  )}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </p>
      <p
        className={cn(
          "max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm",
          m.mine ? "bg-primary text-primary-foreground" : "bg-secondary",
          hidden && "opacity-60 line-through decoration-muted-foreground/40",
        )}
      >
        {m.body ?? "Message removed by a moderator"}
      </p>
    </div>
  );
}

const reasonText: Record<NonNullable<ChatViewer["reason"]>, string> = {
  SIGN_IN_REQUIRED: "Sign in to join the conversation.",
  EMAIL_NOT_VERIFIED: "Verify your email address to chat.",
  ACCOUNT_RESTRICTED: "Your account can't post in chat right now.",
  MUTED: "You're muted in chat",
  BANNED: "You can no longer post in auction chat.",
  CHAT_CLOSED: "Chat is closed for this auction.",
};

function Composer({
  viewer,
  draft,
  setDraft,
  sending,
  onSubmit,
}: {
  viewer: ChatViewer | null;
  draft: string;
  setDraft: (v: string) => void;
  sending: boolean;
  onSubmit: () => void;
}) {
  if (viewer && !viewer.canPost && viewer.reason) {
    return (
      <div className="border-t p-3 text-center text-sm text-muted-foreground">
        {reasonText[viewer.reason]}
        {viewer.reason === "MUTED" && viewer.mutedUntil && ` until ${time(viewer.mutedUntil)}.`}
        {viewer.reason === "SIGN_IN_REQUIRED" && (
          <Link
            to="/login"
            className="ml-1 font-medium text-foreground underline-offset-4 hover:underline"
          >
            Sign in
          </Link>
        )}
        {viewer.reason === "EMAIL_NOT_VERIFIED" && (
          <Link
            to="/verify-email"
            search={{ token: "", delivery: "" }}
            className="ml-1 font-medium text-foreground underline-offset-4 hover:underline"
          >
            Verify now
          </Link>
        )}
      </div>
    );
  }
  const left = CHAT_MAX - draft.length;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="border-t p-3"
    >
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, CHAT_MAX))}
          maxLength={CHAT_MAX}
          placeholder="Say something…"
          aria-label="Chat message"
          disabled={!viewer}
          className="h-11 min-w-0 flex-1 rounded-xl border bg-background px-3 text-sm outline-none focus:border-primary"
        />
        <button
          aria-label="Send"
          disabled={!draft.trim() || sending || !viewer}
          className="grid size-11 place-items-center rounded-xl bg-primary text-primary-foreground disabled:opacity-40"
        >
          <Send className="size-4" />
        </button>
      </div>
      {left < 80 && (
        <p
          className={cn(
            "mt-1 text-right text-[11px]",
            left < 20 ? "text-live" : "text-muted-foreground",
          )}
        >
          {left} characters left
        </p>
      )}
    </form>
  );
}
