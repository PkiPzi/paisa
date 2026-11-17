import { describe, expect, it } from "vitest";
import { closestName, equalShares, parseShares, resolveShares, summarize, type Row } from "@/lib/money";

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

describe("closestName", () => {
  const known = ["Sarthak Shah", "Aman", "Amit", "Riya"];
  it("snaps misheard names to people you have", () => {
    for (const heard of ["Sartak", "Sarthok", "Saarthak", "sarthak"]) expect(closestName(heard, known)).toBe("Sarthak Shah");
    expect(closestName("Ria", known)).toBe("Riya");
  });
  it("leaves new or ambiguous names alone", () => {
    expect(closestName("Karan", known)).toBeNull();
    expect(closestName("Amin", known)).toBeNull(); // as close to Aman as to Amit
  });
});

describe("resolveShares", () => {
  const amounts = (r: ReturnType<typeof resolveShares>) => (typeof r === "string" ? r : r.map((x) => `${x.name}:${x.amount}`));
  it("handles fractions, equal shares and the implicit you", () => {
    expect(amounts(resolveShares([{ name: "me", share: "1/3" }, { name: "Sarthak", share: "2/3" }], 90000))).toEqual(["me:30000", "sarthak:60000"]);
    expect(amounts(resolveShares([{ name: "Sarthak" }, { name: "Riya" }], 10000))).toEqual(["me:3334", "sarthak:3333", "riya:3333"]);
    expect(amounts(resolveShares([{ name: "Sarthak", amount: 250 }], 75000))).toEqual(["me:50000", "sarthak:25000"]);
    expect(amounts(resolveShares([{ name: "a", share: "1/3" }, { name: "b", share: "1/3" }, { name: "me", share: "1/3" }], 100))).toEqual(["a:33", "b:33", "me:34"]);
  });
  it("says what is wrong instead of guessing", () => {
    expect(resolveShares([{ name: "me", amount: 500 }, { name: "Sarthak", amount: 250 }], 90000)).toMatch(/add up to ₹750/);
    expect(resolveShares([{ name: "Sarthak", amount: 2000 }], 90000)).toMatch(/more than/);
    expect(resolveShares([{ name: "me" }], 100)).toMatch(/Who/);
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
