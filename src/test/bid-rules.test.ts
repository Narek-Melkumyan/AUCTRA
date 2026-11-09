import { describe, expect, it } from "vitest";
import { validateBid } from "@/lib/auction-store";
import { buyerFees } from "@/lib/auctions";

const room = { status: "live" as const, currentBid: 10000, increment: 250 };

describe("bid validation", () => {
  it("rejects bids below current + increment", () => {
    expect(validateBid(room, 10000)).toMatch(/Minimum next bid is \$10,250/);
  });
  it("accepts the minimum next bid", () => {
    expect(validateBid(room, 10250)).toBeNull();
  });
  it("rejects bids off the increment", () => {
    expect(validateBid(room, 10300)).toMatch(/increments/);
  });
  it("rejects bids on closed auctions", () => {
    expect(validateBid({ ...room, status: "ended" }, 20000)).toMatch(/not accepting/);
  });
});

describe("buyer fees", () => {
  it("charges 10% premium plus $49", () => {
    expect(buyerFees(10000).total).toBe(11049);
  });
  it("caps premium at $25,000", () => {
    expect(buyerFees(1_000_000).premium).toBe(25000);
  });
});
