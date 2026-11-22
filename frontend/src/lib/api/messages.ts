/** Buyer–seller messaging (API mode). The server enforces that only participants can read. */
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import { onSocketEvent } from "./live";
import { useSession } from "@/lib/demo-session";
import { IS_API_MODE } from "@/lib/auction-store";

export type Party = { id: string; displayName: string; handle: string | null };
export type ConversationSummary = {
  id: string;
  subject: string | null;
  auction: { id: string; title: string; status: string; image: string | null } | null;
  myRole: "buyer" | "seller";
  counterpart: Party | null;
  lastMessage: { body: string | null; createdAt: string; mine: boolean } | null;
  unread: number;
  updatedAt: string;
};
export type DirectMessage = {
  id: string;
  mine: boolean;
  body: string | null;
  hidden: boolean;
  createdAt: string;
};
export type Thread = Omit<ConversationSummary, "lastMessage" | "unread" | "updatedAt"> & {
  counterpartReadAt: string | null;
  hasMore: boolean;
  messages: DirectMessage[];
};
export type MessageEvent = {
  conversationId: string;
  message: { id: string; senderId: string; body: string; createdAt: string };
};

export const messagesApi = {
  list: (page = 1) =>
    api<{ total: number; page: number; limit: number; items: ConversationSummary[] }>(
      `/conversations?page=${page}`,
    ),
  unread: () => api<{ messages: number; conversations: number }>("/conversations/unread"),
  thread: (id: string, before?: string) =>
    api<Thread>(`/conversations/${id}${before ? `?before=${before}` : ""}`),
  start: (auctionId: string, message: string) =>
    api<Thread>("/conversations", { method: "POST", body: { auctionId, message } }),
  send: (id: string, body: string) =>
    api<DirectMessage>(`/conversations/${id}/messages`, { method: "POST", body: { body } }),
  read: (id: string) => api(`/conversations/${id}/read`, { method: "POST" }),
};

/** Unread direct messages for the header badge; refreshed live when a message arrives. */
export function useUnreadMessages() {
  const user = useSession((s) => s.user);
  const qc = useQueryClient();
  const enabled = IS_API_MODE && Boolean(user);
  useEffect(() => {
    if (!enabled) return;
    return onSocketEvent("message", () => {
      void qc.invalidateQueries({ queryKey: ["messages"] });
    });
  }, [enabled, qc]);
  const q = useQuery({
    queryKey: ["messages", "unread", user?.id],
    queryFn: messagesApi.unread,
    enabled,
    staleTime: 30_000,
  });
  return enabled ? (q.data?.messages ?? 0) : 0;
}
