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

const sound = (n: string) => n.toLowerCase().replace(/[^a-z]/g, "").replace(/h/g, "").replace(/(.)\1+/g, "$1"); // Sarthak, Sartak, Saarthak -> sartak
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row.push(Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    prev = row;
  }
  return prev[b.length];
}

/** The known name a misheard `name` most likely means ("Sartak" -> "Sarthak"), or null if none is close or two tie. First names match full ones. */
export function closestName(name: string, known: string[]): string | null {
  const a = sound(name);
  if (a.length < 3) return null;
  const scored = known.map((k) => {
    const d = Math.min(...[k, ...k.split(/\s+/)].map((part) => { const b = sound(part); return editDistance(a, b) <= (b.length >= 6 ? 2 : b.length >= 4 ? 1 : 0) ? editDistance(a, b) : 99; }));
    return { k, d };
  }).filter((x) => x.d < 99).sort((x, y) => x.d - y.d);
  return scored.length && (scored.length === 1 || scored[0].d < scored[1].d) ? scored[0].k : null;
}

export type SplitPart = { name: string; amount?: number; share?: string }; // amount in rupees; share "1/3", "20%" or "0.5"
const ME = /^(me|i|myself|mine|my)$/;
const shareOf = (s: string) => {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(%|\/\s*(\d+(?:\.\d+)?))?\s*$/.exec(s);
  const f = m ? (m[2] === "%" ? Number(m[1]) / 100 : m[3] ? Number(m[1]) / Number(m[3]) : Number(m[1])) : NaN;
  return f > 0 && f <= 1 ? f : null;
};

/**
 * Turns loose split parts into exact paise per person, or an error to show the user.
 * People with an amount or share are fixed; the rest split what is left equally. You are in the split even if unnamed.
 */
export function resolveShares(parts: SplitPart[], total: number): { name: string; amount: number }[] | string {
  const rows: { name: string; fixed?: number }[] = [];
  for (const p of parts) {
    const name = p.name.trim().toLowerCase();
    const f = typeof p.share === "string" ? shareOf(p.share) : undefined;
    if (!name) return "I couldn't tell who one of the shares is for.";
    if (f === null) return `I couldn't read the share "${p.share}".`;
    if (typeof p.amount === "number" && !(p.amount >= 0)) return "An amount can't be negative.";
    rows.push({ name: ME.test(name) ? "me" : name, fixed: typeof p.amount === "number" ? Math.round(p.amount * 100) : f !== undefined ? Math.round(total * f) : undefined });
  }
  if (!rows.some((r) => r.name === "me")) rows.unshift({ name: "me" });
  if (rows.length < 2) return "Who is the split with?";
  const rest = total - rows.reduce((a, r) => a + (r.fixed ?? 0), 0);
  const pool = rows.filter((r) => r.fixed === undefined).sort((a, b) => +(b.name === "me") - +(a.name === "me"));
  if (pool.length) {
    if (rest < 0) return `Those add up to more than the payment of ${rupees(total)}.`;
    equalShares(rest, pool.length).forEach((v, i) => (pool[i].fixed = v));
  } else if (rest !== 0) {
    // Fractions like 1/3 x3 miss by a paisa or two: the payer absorbs it.
    if (Math.abs(rest) >= rows.length || !parts.some((p) => p.share)) return `Those add up to ${rupees(total - rest)}, but the payment was ${rupees(total)}.`;
    rows.find((r) => r.name === "me")!.fixed! += rest;
  }
  return rows.map((r) => ({ name: r.name, amount: r.fixed! }));
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
