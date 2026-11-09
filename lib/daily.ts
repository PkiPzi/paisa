// Once a day (09:00 IST): card bill reminders, and on Sundays the weekly digest.
import { gte, lt, and } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { istDay, rupees, summarize } from "./money";
import { esc, swBalances, tgSend, writeReview } from "./clients";
import { lastMonthFacts, niftyChange, nudges, portfolio, refreshPrices, targetEquityPct, valueOf } from "./invest";

const REMIND_DAYS = [3, 1, 0];

export async function runDaily(now = new Date()): Promise<string[]> {
  const db = getDb();
  const sent: string[] = [];
  const today = istDay(now);

  const upcoming = await db.select().from(schema.bills).where(gte(schema.bills.dueDate, today));
  for (const b of upcoming) {
    const days = Math.round((Date.parse(b.dueDate) - Date.parse(today)) / 86_400_000);
    if (!REMIND_DAYS.includes(days)) continue;
    await tgSend(`💳 <b>${esc(b.card)}</b> bill of <b>${rupees(b.amount)}</b> is due ${days === 0 ? "today" : `in ${days} day${days > 1 ? "s" : ""}`}.`);
    sent.push(`bill:${b.card}`);
  }

  // Prices first, so the digest and review below use today's values. A failed feed must not stop the reminders.
  const priced = await refreshPrices().catch(() => 0);
  if (priced) sent.push(`prices:${priced}`);
  const holdings = await db.select().from(schema.holdings);
  const last = await lastMonthFacts(now);
  const tips = nudges(holdings, last, targetEquityPct(), now);

  if (today.endsWith("-01")) {
    const p = portfolio(holdings);
    const pct = (a: number, b: number) => (b ? `${a >= 0 ? "+" : ""}${((a / b) * 100).toFixed(1)}%` : "n/a");
    const lines = [`📊 <b>${esc(last.month)} review</b>`, `Income ${rupees(last.income)} · spent ${rupees(last.spent)} · invested ${rupees(last.invested)}`];
    if (holdings.length) lines.push(`Investments ${rupees(p.value)} (${pct(p.gain, p.invested)} on ${rupees(p.invested)} put in) · ${p.equityPct}% equity`);
    const review = await writeReview({
      month: last.month, incomeRupees: last.income / 100, spentRupees: last.spent / 100, investedThisMonthRupees: last.invested / 100,
      portfolio: { valueRupees: p.value / 100, investedRupees: p.invested / 100, equityPercent: p.equityPct, targetEquityPercent: targetEquityPct() },
      holdings: holdings.map((h) => ({ name: h.name, category: h.category, valueRupees: valueOf(h) / 100, gainPercent: h.invested ? Math.round(((valueOf(h) - h.invested) / h.invested) * 1000) / 10 : null })),
      nifty50ChangePercent: await niftyChange(), observations: tips,
    });
    if (review) lines.push("", esc(review));
    else if (tips.length) lines.push("", ...tips.map((t) => `• ${esc(t)}`));
    lines.push("", "<i>Based on your own numbers; a prompt to think, not registered investment advice.</i>");
    await tgSend(lines.join("\n"));
    sent.push("review");
  }

  if (new Date(`${today}T12:00:00Z`).getUTCDay() === 0) {
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
    const week = await db.select().from(schema.txns).where(and(gte(schema.txns.at, weekAgo), lt(schema.txns.at, now)));
    const s = summarize(week);
    const lines = [`🗓 <b>Your week</b>`, `Spent <b>${rupees(s.spent)}</b>`];
    s.byCategory.slice(0, 3).forEach(([c, v]) => lines.push(`• ${esc(c)} ${rupees(v)}`));
    if (s.unlabelled) lines.push(`${s.unlabelled} payment${s.unlabelled > 1 ? "s" : ""} still need a label.`);
    try {
      const owed = (await swBalances()).filter((b) => b.amount > 0);
      if (owed.length) lines.push("", "<b>Owed to you</b>", ...owed.slice(0, 6).map((b) => `• ${esc(b.name)} ${rupees(b.amount)}`));
    } catch { /* the digest still goes out without Splitwise */ }
    if (tips.length) lines.push("", "<b>Worth a look</b>", ...tips.slice(0, 2).map((t) => `• ${esc(t)}`));
    await tgSend(lines.join("\n"));
    sent.push("digest");
  }
  return sent;
}
