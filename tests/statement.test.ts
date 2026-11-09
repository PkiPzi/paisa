import { describe, expect, it } from "vitest";
import { parseGrid, parsePdfText, payeeOf } from "@/lib/statement";

// Synthetic layouts in the usual shape of Indian bank exports; replace with real (redacted) rows when available.
describe("parseGrid", () => {
  it("reads separate withdrawal and deposit columns below a preamble", () => {
    const rows = parseGrid([
      ["Account statement for XX1234"],
      ["S No.", "Value Date", "Transaction Date", "Cheque Number", "Transaction Remarks", "Withdrawal Amount (INR )", "Deposit Amount (INR )", "Balance (INR )"],
      ["1", "09/11/2026", "10/11/2026", "", "UPI/RAMESH K/ramesh.k@okaxis/Payment/AXIS BANK/123456789012", "87.00", "0.00", "52,113.00"],
      ["2", "11/11/2026", "11/11/2026", "", "NEFT-SALARY-ACME CORP", "0.00", "1,20,000.00", "1,72,113.00"],
      ["", "", "", "", "Closing balance", "", "", "1,72,113.00"],
    ]);
    expect(rows).toEqual([
      { date: "2026-11-10", narration: "UPI/RAMESH K/ramesh.k@okaxis/Payment/AXIS BANK/123456789012", amount: 8700, direction: "debit" },
      { date: "2026-11-11", narration: "NEFT-SALARY-ACME CORP", amount: 12000000, direction: "credit" },
    ]);
  });

  it("reads a single amount column with a Dr/Cr marker", () => {
    const rows = parseGrid([["Date", "Description", "Amount", "Dr/Cr"], ["10-Nov-2026", "SWIGGY", "450.50", "Dr"], ["12-Nov-2026", "REFUND SWIGGY", "450.50", "Cr"]]);
    expect(rows.map((r) => [r.amount, r.direction])).toEqual([[45050, "debit"], [45050, "credit"]]);
  });
});

describe("parsePdfText", () => {
  it("keeps only lines that start with a date and end with an amount", () => {
    const rows = parsePdfText([
      "   Statement period 12/10/2026 to 11/11/2026",
      "  10/11/2026   7412365890   SWIGGY BANGALORE IN            1,249.50",
      "  11/11/2026   7412365891   PAYMENT RECEIVED, THANK YOU   18,400.00 CR",
      "  Total Amount Due   INR 9,300.00",
    ].join("\n"));
    expect(rows).toEqual([
      { date: "2026-11-10", narration: "7412365890 SWIGGY BANGALORE IN", amount: 124950, direction: "debit" },
      { date: "2026-11-11", narration: "7412365891 PAYMENT RECEIVED, THANK YOU", amount: 1840000, direction: "credit" },
    ]);
  });
});

describe("payeeOf", () => {
  it("keys a UPI narration by its UPI id and names the person", () => {
    expect(payeeOf("UPI/RAMESH K/ramesh.k@okaxis/Payment/AXIS BANK/123456789012")).toEqual({ payee: "RAMESH K", payeeKey: "ramesh.k@okaxis" });
  });
  it("falls back to the narration text", () => {
    expect(payeeOf("7412365890 SWIGGY BANGALORE IN").payeeKey).toBe("7412365890swiggybangalorein");
  });
});
