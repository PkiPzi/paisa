import { describe, expect, it } from "vitest";
import { parseDate, parseEmail, isOtp, knownMailSender } from "@/lib/parse";

// Synthetic samples in typical alert wording; replace with real (redacted) mails once they arrive.
describe("parseEmail", () => {
  it("reads a UPI debit and keys the payee by UPI id", () => {
    const p = parseEmail({
      from: "ICICI Bank <alerts@icicibank.com>", subject: "Transaction alert",
      text: "Dear Customer, your ICICI Bank Account XX1234 has been debited for Rs 87.00 on 10-Nov-26 and account ramesh.k@okaxis has been credited. UPI Ref no 123456789012.",
    });
    expect(p).toEqual({ kind: "txn", amount: 8700, direction: "debit", account: "ICICI a/c 1234", payee: "ramesh.k@okaxis", payeeKey: "ramesh.k@okaxis" });
  });

  it("reads a credit card spend with the merchant", () => {
    const p = parseEmail({
      from: "alerts@axisbank.com", subject: "Transaction alert on your Axis Bank Credit Card",
      text: "Transaction Amount: INR 1,249.50\nMerchant Name: SWIGGY\nAxis Bank Credit Card No. XX9876\nDate & Time: 10-11-26, 20:14:03 IST\nYour card was used for the above purchase.",
    });
    expect(p).toMatchObject({ kind: "txn", amount: 124950, direction: "debit", account: "Axis card 9876", payee: "SWIGGY", payeeKey: "swiggy" });
  });

  it("reads an incoming credit", () => {
    const p = parseEmail({
      from: "donotreply.sbiatm@alerts.sbi.co.in", subject: "Credit alert",
      text: "Dear Customer, Your A/C XXXXX4321 is credited by Rs.500.00 on 09/11/26 from Aman Verma. Ref 99887766.",
    });
    expect(p).toMatchObject({ kind: "txn", amount: 50000, direction: "credit", account: "SBI a/c 4321", payee: "Aman Verma" });
  });

  it("reads a card statement as a bill, not a transaction", () => {
    const p = parseEmail({
      from: "credit_cards@icicibank.com", subject: "Your ICICI Bank Credit Card statement",
      text: "Statement for Credit Card XX5555.\nTotal Amount Due: INR 18,400.00\nMinimum Amount Due: INR 920.00\nPayment Due Date: 25-Nov-2026",
    });
    expect(p).toEqual({ kind: "bill", card: "ICICI card 5555", amount: 1840000, dueDate: "2026-11-25" });
  });

  it("ignores OTP and promotional bank mail", () => {
    expect(parseEmail({ from: "alerts@icicibank.com", subject: "OTP", text: "123456 is your OTP for a transaction of INR 500 at AMAZON." }).kind).toBe("ignored");
    expect(parseEmail({ from: "offers@icicibank.com", subject: "Festive offers", text: "Get 10% off this season." }).kind).toBe("ignored");
  });

  it("reads the merchant of a gateway receipt from the subject", () => {
    const p = parseEmail({ from: "Payments <no-reply@razorpay.com>", subject: "Payment successful for ZEPTO MARKETPLACE PRIVATE LIMITED", text: "Amount paid ₹ 412.00" });
    expect(p).toEqual({ kind: "receipt", merchant: "Zepto", category: "Groceries", amount: 41200 });
  });

  it("reads a merchant receipt total", () => {
    const p = parseEmail({ from: "Rapido <noreply@rapido.bike>", subject: "Your ride receipt", text: "Thanks for riding.\nRide fare ₹80\nTotal ₹87" });
    expect(p).toEqual({ kind: "receipt", merchant: "Rapido", category: "Ride", amount: 8700 });
  });
});

describe("parseDate", () => {
  it("handles the common Indian formats", () => {
    expect(parseDate("25/11/26")).toBe("2026-11-25");
    expect(parseDate("25 Nov 2026")).toBe("2026-11-25");
    expect(parseDate("Nov 25, 2026")).toBe("2026-11-25");
    expect(parseDate("soon")).toBeNull();
  });
});

describe("bank SMS", () => {
  it("reads an ICICI UPI debit", () => {
    const p = parseEmail({ from: "AD-ICICIT-S", subject: "", text: "ICICI Bank Acct XX123 debited for Rs 87.00 on 11-Nov-26; RAMESH K credited. UPI:630112345678. Call 18002662 for dispute." });
    expect(p).toMatchObject({ kind: "txn", amount: 8700, direction: "debit", account: "ICICI a/c 123", payee: "RAMESH K" });
  });
  it("reads an SBI UPI debit that has no currency sign", () => {
    const p = parseEmail({ from: "VM-SBIUPI", subject: "", text: "Dear UPI user A/C X1234 debited by 87.0 on date 11Nov26 trf to RAMESH Refno 630112345678. If not u? call 1800111109. -SBI" });
    expect(p).toMatchObject({ kind: "txn", amount: 8700, direction: "debit", account: "SBI a/c 1234", payee: "RAMESH" });
  });
  it("tells a one-time password from an alert that mentions one", () => {
    expect(isOtp("123456 is the OTP for txn of INR 500.00 at ZEPTO on card XX8734. Do not share.")).toBe(true);
    expect(isOtp("Rs 500 debited from A/c XX1234. Never share your OTP with anyone.")).toBe(false);
  });
});

// Wording taken from real messages, with names and numbers changed.
describe("real formats", () => {
  it("reads the merchant of an ICICI card SMS, not the helpline number", () => {
    const p = parseEmail({ from: "BP-ICICIT-S", subject: "", text: "INR 149.00 spent using ICICI Bank Card XX1234 on 12-Nov-26 on YOUTUBE CYBS. Avl Limit: INR 2,00,000.00. If not you, call 1800 2662/SMS BLOCK 1234 to 9215676766." });
    expect(p).toMatchObject({ kind: "txn", amount: 14900, direction: "debit", account: "ICICI card 1234", payee: "YOUTUBE CYBS" });
  });
  it("reads an Axis card mail whose values sit on the next line", () => {
    const p = parseEmail({ from: "Axis Bank Alerts <alerts@axis.bank.in>", subject: "INR 847 spent on credit card no. XX1234",
      text: "07-11-2026\r\nDear Customer,\r\nHere's the summary of your Axis Bank Credit Card Transaction:\r\nTransaction Amount:\r\nINR 847\r\nMerchant Name:\r\nRSP*SWIGGY\r\nAxis Bank Credit Card No.\r\nXX1234\r\nDate & Time:\r\n07-11-2026, 15:08:21 IST" });
    expect(p).toMatchObject({ kind: "txn", amount: 84700, direction: "debit", account: "Axis card 1234", payee: "RSP*SWIGGY" });
  });
  it("reads a Razorpay receipt, where the amount comes first", () => {
    const p = parseEmail({ from: "Payments <no-reply@razorpay.com>", subject: "Payment successful for ZEPTO MARKETPLACE PRIVATE LIMITED",
      text: "ZEPTO MARKETPLACE PRIVATE LIMITED\n[image: https://cdn.example/check.png]\n₹303.00\nPaid Successfully\nPayment Id pay_abc\nMethod upi someone@okicici" });
    expect(p).toEqual({ kind: "receipt", merchant: "Zepto", category: "Groceries", amount: 30300 });
  });
  it("accepts mail only from banks and receipt senders", () => {
    expect(knownMailSender("ICICI Bank <services@custcomm.icici.bank.in>")).toBe(true);
    expect(knownMailSender("Payments <no-reply@razorpay.com>")).toBe(true);
    expect(knownMailSender("A Recruiter <someone@external.swiggy.in>")).toBe(false);
    expect(knownMailSender("Me <me@gmail.com>")).toBe(false);
  });
});
