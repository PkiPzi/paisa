// Investments: reading a holdings export, pricing it, and turning the numbers into plain nudges.
// The first half is pure; the I/O (price feeds, database) is at the bottom.
import { and, eq, gte, lt } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { istDay, rupees, summarize } from "./money";
import { env } from "./env";

export type Holding = typeof schema.holdings.$inferSelect;
export const CLASSES = ["equity", "debt", "hybrid", "gold", "other"] as const;

// ---------- pure ----------
export type HoldingRow = { isin: string; name: string; units: number; invested: number };

/**
 * A holdings sheet as rows of cell text: any export with ISIN, name, units/quantity and invested value
 * (or average price) columns, or a hand-made CSV with the header `isin,name,units,invested`.
 * shortcut: generic header detection, not yet checked against a real Groww export; the import script
 * prints what it read before storing anything.
 */
export function parseHoldingsGrid(grid: string[][]): HoldingRow[] {
  const find = (row: string[], re: RegExp) => row.findIndex((c) => re.test(c ?? ""));
  const h = grid.findIndex((r) => find(r, /isin/i) >= 0);
  if (h < 0) return [];
  const head = grid[h];
  const num = (c: string | undefined) => Number(/-?[\d,]+(?:\.\d+)?/.exec(c ?? "")?.[0].replace(/,/g, "") ?? NaN);
  const isin = find(head, /isin/i);
  const name = head.findIndex((c, i) => i !== isin && /scheme|fund|stock|company|security|name/i.test(c ?? ""));
  const units = find(head, /unit|quantity|qty/i);
  const invested = find(head, /invested|buy value|cost value|amount/i);
  const avg = find(head, /avg|average/i);
  const out: HoldingRow[] = [];
  for (const r of grid.slice(h + 1)) {
    const id = (r[isin] ?? "").trim().toUpperCase();
    const u = num(r[units]);
    if (!/^IN[A-Z0-9]{10}$/.test(id) || !(u > 0)) continue;
    const cost = invested >= 0 && num(r[invested]) > 0 ? num(r[invested]) : avg >= 0 ? num(r[avg]) * u : 0;
    out.push({ isin: id, name: (r[name] ?? id).trim(), units: u, invested: Math.round((cost || 0) * 100) });
  }
  return out;
}

/** AMFI section header -> asset class, e.g. "Equity Scheme - Large Cap Fund", "Index Funds - Debt Funds", "Gilt". */
export function assetClassOf(amfiHeader: string): (typeof CLASSES)[number] {
  if (/gold|silver/i.test(amfiHeader)) return "gold";
  if (/hybrid/i.test(amfiHeader)) return "hybrid";
  if (/debt|income|liquid|gilt|money market|overnight/i.test(amfiHeader)) return "debt";
  if (/equity|elss|index|etf|growth/i.test(amfiHeader)) return "equity";
  return "other";
}

/** Short category for display and for spotting two funds of the same kind. */
export function categoryOf(amfiHeader: string): string {
  if (/^index funds/i.test(amfiHeader) || /index funds$/i.test(amfiHeader)) return "Index Fund";
  if (/etf/i.test(amfiHeader)) return "ETF";
  return amfiHeader.split(" - ").at(-1)!.trim();
}

/** AMFI's NAVAll.txt: category header lines, then `code;isin;isin2;name;...;nav;date` rows. */
export function parseNav(text: string): Map<string, { name: string; nav: number; date: string; category: string }> {
  const out = new Map<string, { name: string; nav: number; date: string; category: string }>();
  let category = "";
  for (const line of text.split("\n")) {
    const header = /Schemes?\s*\((.+)\)\s*$/.exec(line);
    if (header) { category = header[1].trim(); continue; }
    const f = line.split(";");
    const nav = Number(f.at(-2));
    if (f.length < 6 || !(nav > 0)) continue;
    const name = f.slice(3, -2).map((s) => s.trim()).filter((s) => s && s !== "-").join(" · ");
    for (const isin of [f[1], f[2]]) if (/^INF/.test(isin?.trim() ?? "")) out.set(isin.trim(), { name, nav, date: f.at(-1)!.trim(), category });
  }
  return out;
}

/** Current worth in paise, to the nearest rupee; a holding with no price yet counts at what was paid for it. */
export const valueOf = (h: Holding) => (h.price === null ? h.invested : Math.round(h.units * h.price) * 100);

export function portfolio(hs: Holding[]) {
  const value = hs.reduce((a, h) => a + valueOf(h), 0);
  const invested = hs.reduce((a, h) => a + h.invested, 0);
  const byClass = CLASSES.map((c) => ({ name: c, value: hs.filter((h) => h.assetClass === c).reduce((a, h) => a + valueOf(h), 0) })).filter((c) => c.value > 0);
  const share = (c: string) => (value ? (byClass.find((x) => x.name === c)?.value ?? 0) / value : 0);
  // A hybrid fund is counted as half equity for the allocation check.
  return { value, invested, gain: value - invested, byClass, equityPct: Math.round((share("equity") + share("hybrid") / 2) * 100) };
}

export type MonthFacts = { income: number; spent: number; invested: number };

/** Plain, checkable observations for a lazy investor. Nothing here predicts prices. */
export function nudges(hs: Holding[], last: MonthFacts, targetEquityPct: number, now = new Date()): string[] {
  const out: string[] = [];
  const p = portfolio(hs);

  const surplus = last.income - last.spent - last.invested;
  if (last.income > 0 && surplus > Math.max(500000, last.income * 0.1))
    out.push(`Last month ${rupees(surplus)} of your income was neither spent nor invested. Raising your monthly SIP by about ${rupees(Math.round(surplus / 2 / 50000) * 50000)} would put half of it to work.`);

  if (p.value > 0 && Math.abs(p.equityPct - targetEquityPct) >= 10)
    out.push(`You are ${p.equityPct}% in equity against a ${targetEquityPct}% target. Point new money at ${p.equityPct > targetEquityPct ? "debt" : "equity"} funds until it evens out; there is no need to sell.`);

  const byCategory = Map.groupBy(hs.filter((h) => h.kind === "mf"), (h) => h.category);
  for (const [cat, funds] of byCategory)
    if (funds.length > 1 && /large cap|flexi|multi cap|elss|mid cap|small cap/i.test(cat))
      out.push(`You hold ${funds.length} funds in "${cat}". Funds in one category mostly own the same shares, so one of them is enough for new money.`);

  for (const h of hs)
    if (h.kind === "mf" && /regular/i.test(h.name) && !/direct/i.test(h.name))
      out.push(`${h.name.split(" · ")[0]} is a Regular plan. The Direct plan of the same fund holds the same shares and charges less every year.`);

  for (const h of hs)
    if (h.kind === "stock" && p.value > 0 && valueOf(h) / p.value > 0.15)
      out.push(`${h.name} alone is ${Math.round((valueOf(h) / p.value) * 100)}% of your investments. A single share above 15% is a concentrated bet.`);

  const oldest = hs.reduce((a, h) => Math.min(a, h.importedAt.getTime()), Infinity);
  if (hs.length && now.getTime() - oldest > 40 * 86_400_000)
    out.push("Your holdings were last imported over 40 days ago. Re-import them so new SIP units are counted.");
  return out;
}

// ---------- I/O ----------
const UA = { "User-Agent": "Mozilla/5.0" };

async function yahooPrice(symbol: string): Promise<number | null> {
  // shortcut: Yahoo's chart endpoint is unofficial and may change or rate-limit; swap for a broker API if it does.
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`, { headers: UA, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  const j = (await res.json()) as { chart?: { result?: { meta?: { regularMarketPrice?: number } }[] } };
  return j.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
}

async function yahooSymbol(isin: string): Promise<string | null> {
  const res = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${isin}&quotesCount=5&newsCount=0`, { headers: UA, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  const j = (await res.json()) as { quotes?: { symbol?: string }[] };
  const symbols = (j.quotes ?? []).map((q) => q.symbol ?? "");
  return symbols.find((s) => s.endsWith(".NS")) ?? symbols.find((s) => s.endsWith(".BO")) ?? null;
}

/** Nifty 50 change over one month and one year, for the monthly review. Null if the feed is down. */
export async function niftyChange(): Promise<{ month: number; year: number } | null> {
  try {
    const res = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?range=1y&interval=1mo", { headers: UA, signal: AbortSignal.timeout(15_000) });
    const j = (await res.json()) as { chart?: { result?: { indicators?: { quote?: { close?: (number | null)[] }[] } }[] } };
    const c = (j.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? []).filter((x): x is number => typeof x === "number");
    if (c.length < 3) return null;
    const pct = (a: number, b: number) => Math.round(((b - a) / a) * 1000) / 10;
    return { month: pct(c.at(-2)!, c.at(-1)!), year: pct(c[0], c.at(-1)!) };
  } catch {
    return null;
  }
}

/** Refreshes every holding's price. A feed that fails leaves the old price in place. Returns how many were updated. */
export async function refreshPrices(): Promise<number> {
  const db = getDb();
  const hs = await db.select().from(schema.holdings);
  if (!hs.length) return 0;
  let updated = 0;
  const today = new Date().toISOString().slice(0, 10);

  if (hs.some((h) => h.kind === "mf")) {
    const res = await fetch("https://www.amfiindia.com/spages/NAVAll.txt", { signal: AbortSignal.timeout(40_000) }).catch(() => null);
    const nav = res?.ok ? parseNav(await res.text()) : new Map();
    for (const h of hs.filter((x) => x.kind === "mf")) {
      const n = nav.get(h.isin);
      if (!n) continue;
      await db.update(schema.holdings).set({ price: n.nav, priceAt: n.date, name: n.name, category: categoryOf(n.category), assetClass: assetClassOf(n.category) }).where(eq(schema.holdings.isin, h.isin));
      updated++;
    }
  }
  for (const h of hs.filter((x) => x.kind === "stock")) {
    try {
      const symbol = h.symbol ?? (await yahooSymbol(h.isin));
      const price = symbol ? await yahooPrice(symbol) : null;
      if (!symbol || price === null) continue;
      await db.update(schema.holdings).set({ symbol, price, priceAt: today }).where(eq(schema.holdings.isin, h.isin));
      updated++;
    } catch { /* keep the old price */ }
  }
  return updated;
}

export const targetEquityPct = () => Number(env("TARGET_EQUITY_PCT") ?? 70);

/** Income, spending and money sent to investments in the last full calendar month (IST). */
export async function lastMonthFacts(now = new Date()): Promise<MonthFacts & { month: string }> {
  const [y, m] = istDay(now).split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 2, 1) - 5.5 * 3_600_000);
  const end = new Date(Date.UTC(y, m - 1, 1) - 5.5 * 3_600_000);
  const rows = await getDb().select().from(schema.txns).where(and(gte(schema.txns.at, start), lt(schema.txns.at, end)));
  const s = summarize(rows);
  const invested = rows.filter((r) => r.direction === "debit" && r.category === "Investment").reduce((a, r) => a + r.amount, 0);
  return { income: s.income, spent: s.spent, invested, month: start.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", month: "long", year: "numeric" }) };
}
