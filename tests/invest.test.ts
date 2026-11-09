import { describe, expect, it } from "vitest";
import { assetClassOf, categoryOf, nudges, parseHoldingsGrid, parseNav, portfolio, type Holding } from "@/lib/invest";

const h = (o: Partial<Holding>): Holding => ({
  isin: "INF000000001", name: "Fund", kind: "mf", assetClass: "equity", category: "Large Cap Fund", symbol: null,
  units: 100, invested: 1000000, price: 120, priceAt: null, importedAt: new Date("2026-11-01"), ...o,
});
const now = new Date("2026-11-10");

describe("parseHoldingsGrid", () => {
  it("reads ISIN, units and invested value below a preamble, deriving cost from the average price if needed", () => {
    expect(parseHoldingsGrid([
      ["Holdings statement"],
      ["Scheme Name", "ISIN", "Units", "Invested Value", "Current Value"],
      ["Index Fund Direct Growth", "INF209K01YY6", "152.345", "25,000.00", "31,200.00"],
      ["Total", "", "", "25,000.00", ""],
    ])).toEqual([{ isin: "INF209K01YY6", name: "Index Fund Direct Growth", units: 152.345, invested: 2500000 }]);
    expect(parseHoldingsGrid([["Stock Name", "ISIN", "Quantity", "Average buy price"], ["RELIANCE", "INE002A01018", "10", "1,250.50"]]))
      .toEqual([{ isin: "INE002A01018", name: "RELIANCE", units: 10, invested: 1250500 }]);
  });
});

describe("parseNav", () => {
  it("reads AMFI rows under their category header (lines copied from the live file's layout)", () => {
    const nav = parseNav([
      "Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date",
      "Open Ended Schemes(Equity Scheme - Large Cap Fund)",
      "Axis Mutual Fund",
      "135762;INF846K01WO1;-;Axis Example Fund;Direct Plan;Growth Option;30.9434;09-Nov-2026",
      "135763;INF846K01WS2;INF846K01WQ6;Axis Example Fund;Regular Plan;IDCW Option;N.A.;09-Nov-2026",
    ].join("\n"));
    expect(nav.get("INF846K01WO1")).toEqual({ name: "Axis Example Fund · Direct Plan · Growth Option", nav: 30.9434, date: "09-Nov-2026", category: "Equity Scheme - Large Cap Fund" });
    expect(nav.has("INF846K01WS2")).toBe(false); // no NAV published
    expect(assetClassOf("Debt Scheme - Liquid Fund")).toBe("debt");
    expect(assetClassOf("Index Funds - Equity Funds")).toBe("equity");
    expect(assetClassOf("Index Funds - Debt Funds")).toBe("debt");
    expect(assetClassOf("Hybrid Scheme - Conservative Hybrid Fund")).toBe("hybrid");
    expect(categoryOf("Index Funds - Equity Funds")).toBe("Index Fund");
    expect(categoryOf("Equity Scheme - Large Cap Fund")).toBe("Large Cap Fund");
    expect(assetClassOf("Other Scheme - Gold ETF")).toBe("gold");
  });
});

describe("portfolio and nudges", () => {
  it("values holdings and counts a hybrid fund as half equity", () => {
    const p = portfolio([h({}), h({ isin: "INF000000002", assetClass: "hybrid", units: 100, price: 120 })]);
    expect(p.value).toBe(2400000);
    expect(p.gain).toBe(400000);
    expect(p.equityPct).toBe(75);
  });

  it("is quiet when nothing needs doing", () => {
    const balanced = [h({ units: 70 }), h({ isin: "INF000000002", assetClass: "debt", category: "Liquid Fund", units: 30 })];
    expect(nudges(balanced, { income: 10000000, spent: 6000000, invested: 3500000 }, 70, now)).toEqual([]);
  });

  it("flags surplus cash, allocation drift, duplicate categories, a concentrated share and stale imports", () => {
    const hs = [
      h({}), h({ isin: "INF000000002", name: "Other Fund · Regular Plan · Growth" }),
      h({ isin: "INE000000001", kind: "stock", category: "Stock", name: "BIGCO", units: 100, price: 100, importedAt: new Date("2026-09-01") }),
    ];
    const out = nudges(hs, { income: 10000000, spent: 4000000, invested: 1000000 }, 70, now).join("\n");
    expect(out).toContain("₹50,000 of your income was neither spent nor invested");
    expect(out).toContain("100% in equity against a 70% target");
    expect(out).toContain('2 funds in "Large Cap Fund"');
    expect(out).toContain("is a Regular plan");
    expect(out).toContain("BIGCO alone is 29%");
    expect(out).toContain("last imported over 40 days ago");
  });
});
