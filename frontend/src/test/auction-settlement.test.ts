import { beforeEach, describe, expect, it } from "vitest";
import { getRoomsSnapshot, isWonByMe, placeBid, resetDemo } from "@/lib/auction-store";
import { askAssistant } from "@/lib/ai-mock";
import type { RoomState } from "@/lib/auction-store";

const endedWithMyTopBid = (reserve: RoomState["reserve"]): RoomState => {
  const original = getRoomsSnapshot()["a1001"]!;
  return {
    ...original,
    status: "ended",
    reserve,
    bids: [{ id: "mine", user: "you", amount: original.currentBid, at: Date.now(), mine: true }],
  };
};

describe("auction settlement (demo)", () => {
  beforeEach(resetDemo);

  it("does not treat the highest bidder as the winner when reserve is not met", () => {
    expect(isWonByMe(endedWithMyTopBid("not-met"))).toBe(false);
  });

  it("recognises a winning bid when reserve is met", () => {
    expect(isWonByMe(endedWithMyTopBid("met"))).toBe(true);
  });

  it("recognises a winning bid when no reserve applies", () => {
    expect(isWonByMe(endedWithMyTopBid("none"))).toBe(true);
  });

  it("does not allow another bidder's bid to count as mine", () => {
    const room = endedWithMyTopBid("met");
    room.bids[0]!.mine = false;
    expect(isWonByMe(room)).toBe(false);
  });

  it("rejects a bid after the end time even before the next demo tick", () => {
    const room = getRoomsSnapshot()["a1001"]!;
    room.endsAt = Date.now() - 1;
    const bidsBefore = room.bids.length;
    expect(placeBid(room.id, room.currentBid + room.increment)).toMatch(/ended/);
    expect(getRoomsSnapshot()[room.id]!.bids).toHaveLength(bidsBefore);
  });
});

describe("AI assistant (demo)", () => {
  beforeEach(resetDemo);

  it("returns listing cards for a watch search", () => {
    const result = askAssistant(
      "Find luxury watches under $15,000",
      Object.values(getRoomsSnapshot()),
    );
    expect(result.items?.length).toBeGreaterThan(0);
    expect(result.items?.every((r) => r.category === "Luxury Watches")).toBe(true);
  });
});
