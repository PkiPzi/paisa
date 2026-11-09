import { describe, expect, it } from "vitest";
import { equalShares, parseShares, summarize, type Row } from "@/lib/money";

describe("equalShares", () => {
  it("always adds up to the cost", () => {
    expect(equalShares(10000, 3)).toEqual([3334, 3333, 3333]);
    for (const [cost, n] of [[1, 3], [99999, 7], [50000, 2]]) expect(equalShares(cost, n).reduce((a, b) => a + b, 0)).toBe(cost);
  });
});

describe("parseShares", () => {
  it("reads name-amount pairs", () => {
    expect(parseShares("me 300, Aman 500.50")).toEqual([{ name: "me", amount: 30000 }, { name: "aman", amount: 50050 }]);
  });
  it("rejects anything else", () => {
    expect(parseShares("hello there")).toBeNull();
    expect(parseShares("me 300")).toBeNull();
  });
});

describe("summarize", () => {
  const at = new Date("2026-11-10T12:00:00+05:30");
  const row = (r: Partial<Row>): Row => ({ at, amount: 0, direction: "debit", category: null, myShare: null, ...r });
  it("counts your share, subtracts refunds, skips transfers and card bills", () => {
    const s = summarize([
      row({ amount: 100000, category: "Food", myShare: 25000 }),
      row({ amount: 8700, category: "Ride" }),
      row({ amount: 5000 }), // unlabelled still counts as spend
      row({ amount: 1840000, category: "Card bill" }),
      row({ amount: 2000000, category: "Own transfer" }),
      row({ amount: 3000, direction: "credit", category: "Refund" }),
      row({ amount: 50000, direction: "credit", category: "Settle-up" }),
      row({ amount: 9000000, direction: "credit", category: "Income" }),
    ]);
    expect(s.spent).toBe(25000 + 8700 + 5000 - 3000);
    expect(s.shared).toBe(75000);
    expect(s.income).toBe(9000000);
    expect(s.unlabelled).toBe(1);
    expect(s.byCategory[0]).toEqual(["Food", 25000]);
    expect(s.byDay.get("2026-11-10")).toBe(35700);
  });
});
