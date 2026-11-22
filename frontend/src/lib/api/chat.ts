/**
 * Auction room chat (API mode). History comes from REST; new messages and moderation
 * updates arrive over the room socket. After a reconnect the hook fetches everything
 * after the last sequence number it holds, so nothing posted while offline is missed.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "./client";
import { follow, onSocketEvent } from "./live";

export type ChatStatus = "VISIBLE" | "HIDDEN" | "DELETED";
export type ChatMessage = {
  id: string;
  seq: string;
  auctionId: string;
  author: { handle: string; displayName: string; isSeller: boolean; isStaff: boolean };
  body: string | null;
  status: ChatStatus;
  createdAt: string;
  mine?: boolean;
  /** Present for moderators only. */
  authorId?: string;
  moderation?: { reason: string | null; at: string | null };
};
export type ChatViewer = {
  canPost: boolean;
  reason?:
    | "SIGN_IN_REQUIRED"
    | "EMAIL_NOT_VERIFIED"
    | "ACCOUNT_RESTRICTED"
    | "MUTED"
    | "BANNED"
    | "CHAT_CLOSED";
  mutedUntil?: string;
  isModerator: boolean;
};
type Page = { messages: ChatMessage[]; hasMore: boolean; viewer: ChatViewer };

export const CHAT_MAX = 500;

const bySeq = (a: ChatMessage, b: ChatMessage) =>
  a.seq.length === b.seq.length ? (a.seq < b.seq ? -1 : 1) : a.seq.length - b.seq.length;

/** Merges by id, keeps server order (`seq`), and caps the in-memory history. */
export function mergeChatMessages(list: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const map = new Map(list.map((m) => [m.id, m]));
  for (const m of incoming) map.set(m.id, { ...map.get(m.id), ...m });
  return [...map.values()].sort(bySeq).slice(-300);
}

const newClientId = () =>
  (typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  ).replace(/[^A-Za-z0-9_-]/g, "");

export function useAuctionChat(auctionId: string, myHandle: string | undefined) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [viewer, setViewer] = useState<ChatViewer | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const lastSeq = useRef<string | null>(null);
  const isMod = useRef(false);

  useEffect(() => {
    lastSeq.current = messages.length ? messages[messages.length - 1]!.seq : lastSeq.current;
  }, [messages]);

  const loadLatest = useCallback(async () => {
    try {
      const page = await api<Page>(`/auctions/${auctionId}/chat?limit=50`);
      isMod.current = page.viewer.isModerator;
      setViewer(page.viewer);
      setHasMore(page.hasMore);
      setMessages(page.messages);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Chat is unavailable right now.");
    } finally {
      setLoading(false);
    }
  }, [auctionId]);

  const catchUp = useCallback(async () => {
    if (!lastSeq.current) return loadLatest();
    try {
      const page = await api<Page>(
        `/auctions/${auctionId}/chat?after=${lastSeq.current}&limit=100`,
      );
      setViewer(page.viewer);
      setMessages((list) => mergeChatMessages(list, page.messages));
      if (page.hasMore) await loadLatest();
    } catch {
      /* next reconnect retries */
    }
  }, [auctionId, loadLatest]);

  useEffect(() => {
    setMessages([]);
    setLoading(true);
    lastSeq.current = null;
    follow(auctionId);
    void loadLatest();
    const offMsg = onSocketEvent("chat:message", (p) => {
      const m = p as ChatMessage;
      if (m.auctionId !== auctionId) return;
      setMessages((list) =>
        mergeChatMessages(list, [
          { ...m, mine: m.mine ?? (!!myHandle && m.author.handle === myHandle) },
        ]),
      );
    });
    const offUpd = onSocketEvent("chat:update", (p) => {
      const m = p as ChatMessage;
      if (m.auctionId !== auctionId) return;
      if (isMod.current) {
        // Moderators see hidden bodies; refresh that message's details from REST.
        void catchUpModerated();
        return;
      }
      setMessages((list) =>
        m.status === "VISIBLE"
          ? mergeChatMessages(list, [{ ...m, mine: !!myHandle && m.author.handle === myHandle }])
          : list.filter((x) => x.id !== m.id),
      );
    });
    const offConn = onSocketEvent("connect", () => void catchUp());
    async function catchUpModerated() {
      await loadLatest();
    }
    return () => {
      offMsg();
      offUpd();
      offConn();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auctionId]);

  const loadOlder = useCallback(async () => {
    const first = messages[0];
    if (!first) return;
    const page = await api<Page>(`/auctions/${auctionId}/chat?before=${first.seq}&limit=50`);
    setHasMore(page.hasMore);
    setMessages((list) => [
      ...page.messages,
      ...list.filter((m) => !page.messages.some((p) => p.id === m.id)),
    ]);
  }, [auctionId, messages]);

  const send = useCallback(
    async (body: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        const m = await api<ChatMessage>(`/auctions/${auctionId}/chat`, {
          method: "POST",
          body: { body, clientMessageId: newClientId() },
        });
        setMessages((list) => mergeChatMessages(list, [m]));
        return { ok: true };
      } catch (err) {
        if (err instanceof ApiError) {
          if (["CHAT_MUTED", "CHAT_BANNED", "EMAIL_NOT_VERIFIED", "CHAT_CLOSED"].includes(err.code))
            void loadLatest(); // refresh the composer state
          return { ok: false, error: err.message };
        }
        return { ok: false, error: "Message was not sent. Please try again." };
      }
    },
    [auctionId, loadLatest],
  );

  const report = useCallback(async (id: string, reason: string) => {
    try {
      const r = await api<{ duplicate: boolean }>(`/chat/messages/${id}/report`, {
        method: "POST",
        body: { reason },
      });
      return { ok: true as const, duplicate: r.duplicate };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof ApiError ? err.message : "Could not report.",
      };
    }
  }, []);

  const moderate = useCallback(
    async (id: string, action: "hide" | "delete" | "restore", reason?: string) => {
      try {
        const m = await api<ChatMessage>(`/admin/chat/messages/${id}/${action}`, {
          method: "POST",
          body: reason ? { reason } : {},
        });
        setMessages((list) => mergeChatMessages(list, [m]));
        return { ok: true as const };
      } catch (err) {
        return { ok: false as const, error: err instanceof ApiError ? err.message : "Failed." };
      }
    },
    [],
  );

  const restrict = useCallback(async (authorId: string, type: "MUTE" | "BAN", minutes?: number) => {
    try {
      await api(`/admin/chat/restrictions`, {
        method: "POST",
        body: {
          userId: authorId,
          type,
          ...(type === "MUTE" ? { minutes: minutes ?? 15 } : {}),
          reason: "Moderated from the auction room",
        },
      });
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: err instanceof ApiError ? err.message : "Failed." };
    }
  }, []);

  return {
    messages,
    viewer,
    hasMore,
    loading,
    error,
    send,
    loadOlder,
    report,
    moderate,
    restrict,
    retry: loadLatest,
  };
}
