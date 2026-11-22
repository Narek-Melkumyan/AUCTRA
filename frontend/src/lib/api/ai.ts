/**
 * AI assistant client (API mode). Answers stream from POST /api/ai/chat as Server-Sent
 * Events. The OpenAI key stays on the server; this only talks to the AUCTRA API.
 */
import { API_URL, ApiError, api, getAccessToken, refreshSession } from "./client";

export type AiScope = "user" | "admin";

export type AiStatus = {
  configured: boolean;
  scope: string;
  maxInputChars: number;
  reason?: string;
  requiresSignIn?: boolean;
  allowed?: boolean;
  model?: string;
  usage?: { usedToday: number; dailyLimit: number; remainingToday: number };
};

export type ListingCard = {
  id: string;
  title: string;
  category: string;
  phase: string;
  formattedPrice: string;
  bidCount: number;
  endsAt: string;
  startsAt: string;
  image: string | null;
  link: string;
};

export type ProposedAction = {
  action:
    "suspend_user" | "ban_user" | "mute_chat" | "ban_chat" | "hide_message" | "cancel_auction";
  targetType: "user" | "chat_message" | "auction";
  targetId: string;
  targetLabel: string;
  reason: string;
};

export type AiMessage = {
  id: string;
  role: "USER" | "ASSISTANT";
  content: string;
  listings?: ListingCard[];
  proposals?: ProposedAction[];
  error?: boolean;
};

export type ConversationSummary = { id: string; title: string; updatedAt: string };

export const aiApi = {
  status: (scope: AiScope) => api<AiStatus>(`/ai/status?scope=${scope}`),
  conversations: (scope: AiScope) => api<ConversationSummary[]>(`/ai/conversations?scope=${scope}`),
  conversation: async (id: string): Promise<AiMessage[]> => {
    const c = await api<{
      messages: {
        id: string;
        role: "USER" | "ASSISTANT";
        content: string;
        data: { listings?: ListingCard[]; proposals?: ProposedAction[] } | null;
      }[];
    }>(`/ai/conversations/${id}`);
    return c.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      ...(m.data?.listings?.length ? { listings: m.data.listings } : {}),
      ...(m.data?.proposals?.length ? { proposals: m.data.proposals } : {}),
    }));
  },
  remove: (id: string) => api(`/ai/conversations/${id}`, { method: "DELETE" }),
  usage: (days = 30) =>
    api<{
      configured: boolean;
      model: string;
      limits: { userDaily: number; adminDaily: number; globalDaily: number };
      byDay: { day: string; tokens: number; requests: number }[];
      byScope: { scope: string; requests: number; totalTokens: number }[];
    }>(`/ai/usage?days=${days}`),
};

export type StreamHandlers = {
  onMeta?: (conversationId: string) => void;
  onTool?: (label: string) => void;
  onDelta?: (text: string) => void;
  onDone?: (d: {
    messageId: string;
    text: string;
    listings: ListingCard[];
    proposals: ProposedAction[];
    remainingTokens: number;
  }) => void;
  onError?: (message: string, code: string) => void;
};

/** Sends one question and dispatches streamed events. Resolves when the stream ends. */
export async function streamChat(
  scope: AiScope,
  body: { message: string; conversationId?: string; auctionId?: string },
  h: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const send = () =>
    fetch(`${API_URL}/ai/chat?scope=${scope}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(getAccessToken() ? { Authorization: `Bearer ${getAccessToken()}` } : {}),
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  let res = await send();
  if (res.status === 401 && (await refreshSession())) res = await send();
  if (!res.ok || !res.body) {
    let err: { code?: string; message?: string } = {};
    try {
      err = (await res.json()) as typeof err;
    } catch {
      /* ignore */
    }
    throw new ApiError(
      res.status,
      err.code ?? `HTTP_${res.status}`,
      err.message ?? "The assistant is unavailable.",
    );
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = block
        .split("\n")
        .find((l) => l.startsWith("data: "))
        ?.slice(6);
      if (!data) continue;
      const e = JSON.parse(data) as { type: string } & Record<string, unknown>;
      if (e.type === "meta") h.onMeta?.(e["conversationId"] as string);
      else if (e.type === "tool") h.onTool?.(e["label"] as string);
      else if (e.type === "delta") h.onDelta?.(e["text"] as string);
      else if (e.type === "done") h.onDone?.(e as never);
      else if (e.type === "error") h.onError?.(e["message"] as string, e["code"] as string);
    }
  }
}
