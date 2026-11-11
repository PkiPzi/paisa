// Turns one forwarded mail into a transaction, a card bill or a merchant receipt. Pure: no I/O.
// shortcut: one generic parser written from typical alert wording, not from the user's real mails;
// re-check against stored `emails.body` rows once real ICICI / SBI / Axis mail has arrived.

export type Parsed =
  | { kind: "txn"; amount: number; direction: "debit" | "credit"; account: string; payee: string; payeeKey: string }
  | { kind: "bill"; card: string; amount: number; dueDate: string }
  | { kind: "receipt"; merchant: string; category: string; amount: number }
  | { kind: "ignored" };

const BANKS: [RegExp, string][] = [[/icici/i, "ICICI"], [/sbi|statebank/i, "SBI"], [/axis/i, "Axis"]];
const MERCHANTS: [RegExp, string, string][] = [
  [/rapido/i, "Rapido", "Ride"], [/uber/i, "Uber", "Ride"], [/olacabs|ola\b/i, "Ola", "Ride"],
  [/swiggy/i, "Swiggy", "Food"], [/zomato/i, "Zomato", "Food"],
  [/blinkit/i, "Blinkit", "Groceries"], [/zepto/i, "Zepto", "Groceries"],
];

const MONEY = String.raw`(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)`;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "1,234.50" -> 123450 paise. */
export function toPaise(s: string): number {
  return Math.round(Number(s.replace(/,/g, "")) * 100);
}

/** Accepts 25-11-2026, 25/11/26, 25-Nov-2026, 25 Nov 2026, Nov 25, 2026. Returns YYYY-MM-DD or null. */
export function parseDate(s: string): string | null {
  let d: number, m: number, y: number;
  let r = /(\d{1,2})[-/ ](\d{1,2})[-/ ](\d{2,4})/.exec(s);
  if (r) [d, m, y] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = /(\d{1,2})[-/ ,]+([A-Za-z]{3})[a-z]*[-/ ,]+(\d{2,4})/.exec(s))) [d, m, y] = [Number(r[1]), MONTHS.indexOf(r[2].toLowerCase()) + 1, Number(r[3])];
  else if ((r = /([A-Za-z]{3})[a-z]*[ ]+(\d{1,2}),?[ ]+(\d{4})/.exec(s))) [d, m, y] = [Number(r[2]), MONTHS.indexOf(r[1].toLowerCase()) + 1, Number(r[3])];
  else return null;
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function payeeKeyOf(payee: string): string {
  return payee.toLowerCase().replace(/[^a-z0-9@._-]/g, "");
}

export const bankOf = (from: string) => BANKS.find(([re]) => re.test(from))?.[1];

/** A one-time password message. A real alert that only warns "never share your OTP" is not one. */
export const isOtp = (text: string) =>
  /\b(otp|one time password)\b/i.test(text) && !/\b(debited|credited|spent|withdrawn|received)\b/i.test(text);

export function parseEmail(mail: { from: string; subject: string; text: string }): Parsed {
  const text = `${mail.subject}\n${mail.text}`.replace(/[ \t ]+/g, " ");
  const bank = bankOf(mail.from);

  if (!bank) {
    // A payment gateway (Razorpay) names the merchant in the subject, not the sender.
    const m = MERCHANTS.find(([re]) => re.test(`${mail.from} ${mail.subject}`));
    // shortcut: the Razorpay body wording is a guess; check it against a stored mail once one has been forwarded.
    const total = new RegExp(String.raw`(?:total|amount paid|you paid|bill|paid successfully|amount)[^₹\d\n]{0,40}${MONEY}`, "i").exec(text);
    return m && total ? { kind: "receipt", merchant: m[1], category: m[2], amount: toPaise(total[1]) } : { kind: "ignored" };
  }

  const last4 = /(?:\b[Xx]+|\*{2,}|\bending(?: in| with)?) ?(\d{3,4})\b/.exec(text)?.[1] ?? "";
  const isCard = /credit card/i.test(text);

  const due = new RegExp(String.raw`total (?:amount )?due[^₹\d\n]{0,40}${MONEY}`, "i").exec(text);
  const dueDate = /due date[^\dA-Za-z\n]{0,10}(?:is |of |on )?([^\n]{6,20})/i.exec(text);
  if (due && dueDate) {
    const iso = parseDate(dueDate[1]);
    if (iso) return { kind: "bill", card: `${bank} card ${last4}`.trim(), amount: toPaise(due[1]), dueDate: iso };
  }

  if (isOtp(text) || /\b(declined|failed|unsuccessful|will be debited|is due)\b/i.test(text)) return { kind: "ignored" };
  // shortcut: SMS wording ("debited by 87.0", "; NAME credited") is from memory, not the user's real messages;
  // re-check against stored `emails.body` rows whose id starts with "sms:".
  const amount = new RegExp(MONEY, "i").exec(text) ?? /\b(?:debited|credited) (?:by|for|with) ([\d,]+(?:\.\d{1,2})?)/i.exec(text);
  // An alert can name both sides ("your a/c debited ... payee credited"); the first word is about your account.
  const dir = /\b(debited|debit|spent|used for|paid|withdrawn|purchase|credited|credit of|received|refund(?:ed)?|reversed)\b/i.exec(text);
  if (!amount || !dir) return { kind: "ignored" };
  const direction = /credit|received|refund|reversed/i.test(dir[1]) ? "credit" : "debit";

  // A UPI id has no dot after the handle ("name@okaxis"), which is what separates it from an email address.
  const vpa = /\b[\w.-]{2,}@[a-z][a-z0-9]{1,}\b(?![.\w])/i.exec(text)?.[0];
  const side = direction === "debit" ? "at|to|towards" : "from|by";
  const name =
    /merchant(?: name)?:? ?([^\n]{2,40})/i.exec(text)?.[1] ??
    /\binfo:? ?([^\n.]{2,40})/i.exec(text)?.[1] ??
    (direction === "debit" ? /; ?([A-Za-z0-9][^;.\n]{1,40}?) credited\b/i.exec(text)?.[1] : undefined) ??
    new RegExp(String.raw`\b(?:${side}) ((?!your\b|a\/c\b|account\b|the\b|inr\b|rs\b)[A-Za-z0-9][\w &'*/-]{1,40}?)(?= on\b| has\b| via\b| with\b| ref(?:no)?\b| upi\b| using\b|[.,;\n]|$)`, "i").exec(text)?.[1];
  const payee = (name ?? vpa ?? "Unknown").trim();

  return {
    kind: "txn", amount: toPaise(amount[1]), direction,
    account: `${bank} ${isCard ? "card" : "a/c"} ${last4}`.trim(),
    payee, payeeKey: payeeKeyOf(vpa ?? payee),
  };
}
