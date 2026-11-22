import { render, screen } from "@testing-library/react";
import { vi } from "vitest";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-router")>()),
  useRouter: () => ({ navigate }),
}));

import { SafeMarkdown } from "@/components/ai/SafeMarkdown";
import { streamChat } from "@/lib/api/ai";
import { mergeChatMessages, type ChatMessage } from "@/lib/api/chat";
import { adminAccess } from "@/lib/api/admin";
import { toOrder } from "@/lib/api/adapters";

function sseResponse(chunks: string[]) {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

describe("assistant streaming client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("parses SSE events even when they are split across network chunks", async () => {
    const ev = (o: object) => `event: x\ndata: ${JSON.stringify(o)}\n\n`;
    const body =
      ev({ type: "meta", conversationId: "c1" }) +
      ev({ type: "tool", name: "search_auctions", label: "Searching auctions" }) +
      ev({ type: "delta", text: "Hel" }) +
      ev({ type: "delta", text: "lo" }) +
      ev({
        type: "done",
        messageId: "m1",
        text: "Hello",
        listings: [],
        proposals: [],
        remainingTokens: 5,
      });
    // Split at awkward positions, including inside a JSON payload.
    const chunks = [body.slice(0, 17), body.slice(17, 90), body.slice(90, 91), body.slice(91)];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse(chunks)),
    );
    const seen: string[] = [];
    let text = "";
    await streamChat(
      "user",
      { message: "hi" },
      {
        onMeta: (id) => seen.push(`meta:${id}`),
        onTool: (l) => seen.push(`tool:${l}`),
        onDelta: (d) => (text += d),
        onDone: (d) => seen.push(`done:${d.messageId}`),
      },
    );
    expect(seen).toEqual(["meta:c1", "tool:Searching auctions", "done:m1"]);
    expect(text).toBe("Hello");
  });

  it("surfaces JSON errors returned before the stream starts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ code: "AI_NOT_CONFIGURED", message: "not configured" }), {
            status: 503,
          }),
      ),
    );
    await expect(streamChat("user", { message: "hi" }, {})).rejects.toMatchObject({
      code: "AI_NOT_CONFIGURED",
      status: 503,
    });
  });
});

describe("SafeMarkdown", () => {
  it("renders model output as text, never as HTML", () => {
    const { container } = render(
      <SafeMarkdown
        text={'<img src=x onerror="alert(1)"> **bold** and <script>alert(2)</script>'}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(container.textContent).toContain("<script>alert(2)</script>");
  });

  it("links only to in-app paths", () => {
    const id = "3e3ae236-3be9-4489-a49a-9c0098f38bed";
    const { container } = render(
      <SafeMarkdown
        text={`See [the lot](/room/${id}), [evil](javascript:alert(1)) and [ext](https://evil.test).\n- one\n- two`}
      />,
    );
    const links = [...container.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([`/room/${id}`]);
    expect(container.textContent).toContain("evil");
    expect(container.querySelectorAll("li")).toHaveLength(2);
  });
});

describe("chat history merge", () => {
  const msg = (id: string, seq: string, body = id): ChatMessage => ({
    id,
    seq,
    auctionId: "a",
    author: { handle: "h", displayName: "H", isSeller: false, isStaff: false },
    body,
    status: "VISIBLE",
    createdAt: new Date().toISOString(),
  });

  it("deduplicates and orders by numeric sequence", () => {
    const merged = mergeChatMessages(
      [msg("a", "9"), msg("b", "10")],
      [msg("c", "100"), msg("a", "9", "edited"), msg("d", "11")],
    );
    expect(merged.map((m) => m.id)).toEqual(["a", "b", "d", "c"]);
    expect(merged[0]!.body).toBe("edited");
  });
});

describe("admin access mapping", () => {
  it("mirrors server permissions per section", () => {
    expect(adminAccess(["bid:place"]).any).toBe(false);
    const mod = adminAccess([
      "chat:moderate",
      "report:handle",
      "user:read:any",
      "auction:read:any",
    ]);
    expect(mod).toMatchObject({
      any: true,
      chat: true,
      reports: true,
      analytics: false,
      notifications: false,
      suspend: false,
    });
    expect(adminAccess(["analytics:read", "ai:admin"])).toMatchObject({
      analytics: true,
      ai: true,
    });
  });
});

describe("orders", () => {
  it("maps a demo-completed order with the server total", () => {
    const o = toOrder({
      id: "o1",
      orderNumber: "ORD-000010",
      role: "buyer",
      status: "COMPLETED",
      auction: { id: "a1", title: "Watch", image: null },
      hammerPrice: { minor: "320000", currency: "USD" },
      total: { minor: "344000", currency: "USD" },
      createdAt: "2026-11-14T00:00:00Z",
      simulated: true,
      demoCompletedAt: "2026-11-15T10:00:00Z",
    });
    expect(o).toMatchObject({
      status: "completed",
      total: 3440,
      hammer: 3200,
      simulated: true,
      date: "2026-11-15",
    });
  });
});
