import { describe, expect, it } from "vitest";
import { majorToMinor, minorToMajor } from "@/lib/api/client";
import { countryCode, toNotice } from "@/lib/api/adapters";
import { minimumBid, validateBid } from "@/lib/auction-store";

describe("API money conversion", () => {
  it("converts exactly between major and minor units", () => {
    expect(majorToMinor(14250, "USD")).toBe("1425000");
    expect(majorToMinor(0.1 + 0.2, "USD")).toBe("30");
    expect(majorToMinor(5000, "JPY")).toBe("5000");
    expect(minorToMajor("1425050", "USD")).toBe(14250.5);
    expect(() => majorToMinor(-1)).toThrow();
  });
});

describe("server-provided bid minimum", () => {
  it("allows the opening bid at the starting price when the server says so", () => {
    const opening = { status: "live" as const, currentBid: 9000, increment: 250, minNextBid: 9000 };
    expect(minimumBid(opening)).toBe(9000);
    expect(validateBid(opening, 9000)).toBeNull();
    expect(validateBid(opening, 8999)).toMatch(/Minimum next bid is \$9,000/);
  });
  it("falls back to current + increment without server data (demo)", () => {
    expect(minimumBid({ currentBid: 9000, increment: 250 })).toBe(9250);
  });
});

describe("adapters", () => {
  it("maps notifications and countries", () => {
    expect(
      toNotice({
        id: "n1",
        type: "OUTBID",
        title: "Outbid",
        body: "",
        auctionId: "a",
        link: "/room/a",
        read: false,
        createdAt: "2026-01-01T00:00:00Z",
      }),
    ).toMatchObject({ kind: "outbid", link: "/room/a", type: "OUTBID" });
    expect(countryCode("United Kingdom")).toBe("GB");
    expect(countryCode("ch")).toBe("CH");
    expect(countryCode("Atlantis")).toBeUndefined();
  });
});
