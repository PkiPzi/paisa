// Categories and the pure money maths (splits, month summary). No I/O.

export const SPEND = ["Food", "Groceries", "Ride", "Travel", "Shopping", "Bills", "Rent", "Health", "Fun", "Subscriptions", "Other"] as const;
/** Money that moved but was not spent or earned in the everyday sense. */
export const DEBIT_OTHER = ["Own transfer", "Card bill", "Settle-up", "Investment"] as const;
export const CREDIT = ["Refund", "Settle-up", "Income", "Own transfer"] as const;
export const ALL = [...new Set<string>([...SPEND, ...DEBIT_OTHER, ...CREDIT])];
const isSpend = (c: string | null) => c === null || (SPEND as readonly string[]).includes(c);

export function rupees(paise: number): string {
  const r = paise / 100;
  return "₹" + r.toLocaleString("en-IN", { minimumFractionDigits: Number.isInteger(r) ? 0 : 2, maximumFractionDigits: 2 });
}

/** Splits `cost` paise over `n` people so the parts always add up; spare paise go to the first (the payer). */
export function equalShares(cost: number, n: number): number[] {
  const base = Math.floor(cost / n);
  return Array.from({ length: n }, (_, i) => base + (i < cost - base * n ? 1 : 0));
}

/** "me 300, Aman 500.50" -> [{name:"me",amount:30000},{name:"aman",amount:50050}]; null if any part is malformed. */
export function parseShares(text: string): { name: string; amount: number }[] | null {
  const parts = text.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
  const out = parts.map((p) => /^([A-Za-z][A-Za-z .]*?)\s*[:=]?\s*₹?\s*(\d+(?:\.\d{1,2})?)$/.exec(p));
  if (out.length < 2 || out.some((m) => !m)) return null;
  return out.map((m) => ({ name: m![1].trim().toLowerCase(), amount: Math.round(Number(m![2]) * 100) }));
}

export type Row = { at: Date; amount: number; direction: string; category: string | null; myShare: number | null };

const IST_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD
export const istDay = (d: Date) => IST_DAY.format(d);

/** Spending = your share of spend-category debits (unlabelled ones count as spend) minus refunds. */
export function summarize(rows: Row[]) {
  const byCategory = new Map<string, number>();
  const byDay = new Map<string, number>();
  let spent = 0, income = 0, shared = 0, unlabelled = 0;
  for (const r of rows) {
    if (r.category === null) unlabelled++;
    let delta = 0;
    if (r.direction === "debit" && isSpend(r.category)) {
      delta = r.myShare ?? r.amount;
      if (r.myShare !== null) shared += r.amount - r.myShare;
    } else if (r.direction === "credit" && r.category === "Refund") delta = -r.amount;
    else if (r.direction === "credit" && r.category === "Income") income += r.amount;
    if (!delta) continue;
    spent += delta;
    const cat = r.direction === "credit" ? "Refunds" : (r.category ?? "Unlabelled");
    byCategory.set(cat, (byCategory.get(cat) ?? 0) + delta);
    byDay.set(istDay(r.at), (byDay.get(istDay(r.at)) ?? 0) + delta);
  }
  return {
    spent, income, shared, unlabelled, byDay,
    byCategory: [...byCategory].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]),
  };
}
