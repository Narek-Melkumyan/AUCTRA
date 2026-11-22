import { vi } from "vitest";
import { eventAction } from "@/lib/api/live";
import { apiServices } from "@/services/api";

describe("versioned event ordering", () => {
  it("applies the next version, ignores duplicates/old ones, resyncs on gaps", () => {
    expect(eventAction(4, 5)).toBe("apply");
    expect(eventAction(4, 4)).toBe("ignore"); // duplicate delivery
    expect(eventAction(4, 2)).toBe("ignore"); // late, out-of-order
    expect(eventAction(4, 7)).toBe("resync"); // missed 5 and 6
    expect(eventAction(0, 1)).toBe("apply");
  });
});

describe("bid retries keep the same idempotency key", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("retries transient failures automatically and reuses the key for a manual retry", async () => {
    const keys: string[] = [];
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        keys.push((init.headers as Record<string, string>)["Idempotency-Key"]!);
        calls++;
        if (calls <= 3) throw new TypeError("network down"); // first click: all attempts fail
        if (calls === 4)
          return new Response(
            JSON.stringify({
              code: "BID_SYSTEM_BUSY",
              message: "busy",
              details: { retryAfterMs: 1 },
            }),
            { status: 503 },
          );
        return new Response(
          JSON.stringify({
            bid: {
              id: "b1",
              sequence: 1,
              amount: { minor: "100000", currency: "USD" },
              bidderAlias: "x",
              mine: true,
              createdAt: new Date().toISOString(),
            },
            auction: { auctionId: "a1", version: 2 },
          }),
          { status: 201 },
        );
      }),
    );
    const first = await apiServices.bidding.placeBid("a1", 1000);
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error).toMatch(/retry safely/);
    const second = await apiServices.bidding.placeBid("a1", 1000);
    expect(second.ok).toBe(true);
    // 3 attempts on the first click + 2 on the second (503 then 201): all one key.
    expect(keys).toHaveLength(5);
    expect(new Set(keys).size).toBe(1);

    // A definitive answer clears the key: the next logical bid gets a new one.
    await apiServices.bidding.placeBid("a1", 1000);
    expect(keys.at(-1)).not.toBe(keys[0]);
  }, 15_000);

  it("does not reuse the key after a definitive rejection", async () => {
    const keys: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        keys.push((init.headers as Record<string, string>)["Idempotency-Key"]!);
        return new Response(JSON.stringify({ code: "BID_TOO_LOW", message: "too low" }), {
          status: 422,
        });
      }),
    );
    const r1 = await apiServices.bidding.placeBid("a2", 500);
    const r2 = await apiServices.bidding.placeBid("a2", 500);
    expect(r1.ok || r2.ok).toBe(false);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });
});
