import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { vi } from "vitest";

vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
const calls = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/api/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/api/client")>()),
  api: vi.fn(async (path: string) => {
    calls.push(path);
    const page = Number(new URLSearchParams(path.split("?")[1]).get("page") ?? 1);
    if (path.includes("phase=live")) return { items: [], total: 30, page, limit: 24 };
    return { items: [], total: 0, page: 1, limit: 8 };
  }),
}));

import { ApiLive } from "@/components/explore/ApiLive";

describe("Live Now (API mode)", () => {
  it("shows the server's live total and pages through it instead of loading everything", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ApiLive />
      </QueryClientProvider>,
    );
    await screen.findByText(/30 rooms open right now/);
    expect(calls).toContain("/auctions?phase=live&sort=ending_soon&limit=24&page=1");
    expect(calls).toContain("/auctions?phase=ended&sort=recently_ended&limit=8");
    fireEvent.click(screen.getByRole("button", { name: /Show more \(30 more live\)/ }));
    await waitFor(() =>
      expect(calls).toContain("/auctions?phase=live&sort=ending_soon&limit=24&page=2"),
    );
  });
});
