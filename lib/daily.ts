// Once a day (09:00 IST): card bill reminders, and on Sundays the weekly digest.
import { gte, lt, and } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { istDay, rupees, summarize } from "./money";
import { esc, swBalances, tgSend } from "./clients";

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
    await tgSend(lines.join("\n"));
    sent.push("digest");
  }
  return sent;
}
