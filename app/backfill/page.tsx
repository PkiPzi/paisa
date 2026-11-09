import Link from "next/link";
import { and, desc, eq, gte, inArray, isNull, like, or } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { SPEND, istDay, rupees } from "@/lib/money";
import { equalPlan, loadSplitwise } from "@/lib/bot";
import { swName } from "@/lib/clients";
import { env } from "@/lib/env";
import { postBackfill } from "./actions";
import { MAX_BATCH } from "./limits";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const { txns } = schema;
const MIN_AMOUNT = 10000; // ₹100: smaller payments are rarely worth splitting a year later
const OFTEN_SHARED = ["Food", "Groceries", "Travel", "Fun", "Rent", "Bills", "Ride"];
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function Backfill({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const target = one(sp.target);
  const picks = [sp.pick ?? []].flat().map(Number).filter(Number.isInteger).slice(0, MAX_BATCH);
  const db = getDb();

  const sw = env("SPLITWISE_API_KEY") ? await loadSplitwise().catch(() => null) : null;
  const open = and(like(txns.emailId, "stmt:%"), eq(txns.direction, "debit"), isNull(txns.splitwiseId));

  // Step 2: the dry-run preview of exactly what would be posted.
  if (sw && picks.length && target) {
    const chosen = await db.select().from(txns).where(and(open, inArray(txns.id, picks))).orderBy(desc(txns.at));
    const plans = chosen.map((t) => ({ t, plan: equalPlan(sw, target, t.amount) }));
    const first = plans[0]?.plan;
    const others = first ? first.owed.length - 1 : 0;
    const back = plans.reduce((a, p) => a + p.t.amount - (p.plan?.owed[0].amount ?? p.t.amount), 0);
    return (
      <main className="page narrow">
        <header className="top"><Link className="brand" href="/">Paisa</Link><Link className="link" href="/backfill">← Change selection</Link></header>
        <section className="card">
          <h2>Dry run: nothing has been posted yet</h2>
          {!first ? <p className="alert">That Splitwise group or friend was not found.</p> : <>
            <p className="big">{rupees(back)}</p>
            <p className="muted">comes back to you from <b>{first.label}</b>: {chosen.length} expense{chosen.length > 1 ? "s" : ""}, each split equally between you and {others} other{others > 1 ? "s" : ""}.</p>
            <p className="nudge static">Splitwise notifies {others > 1 ? "everyone in the group" : first.label} about each expense as it is added.</p>
            <ul className="txns">
              {plans.map(({ t, plan }) => (
                <li key={t.id}>
                  <div className="who"><span>{t.payee}</span><small className="muted">{istDay(t.at)} · {t.account} · others owe {rupees(plan!.owed[1]?.amount ?? 0)} each</small></div>
                  <span className="muted num">your share {rupees(plan!.owed[0].amount)}</span>
                  <span className="num amt">{rupees(t.amount)}</span>
                </li>
              ))}
            </ul>
            <form action={postBackfill} className="bar">
              <input type="hidden" name="target" value={target} />
              {chosen.map((t) => <input key={t.id} type="hidden" name="pick" value={t.id} />)}
              <Link className="btn ghost" href="/backfill">Cancel</Link>
              <button className="btn">Post {chosen.length} expense{chosen.length > 1 ? "s" : ""} to Splitwise</button>
            </form>
          </>}
        </section>
      </main>
    );
  }

  // Step 1: pick the shared payments.
  const rows = await db.select().from(txns)
    .where(and(open, gte(txns.amount, MIN_AMOUNT), or(isNull(txns.category), inArray(txns.category, [...SPEND]))))
    .orderBy(desc(txns.at));
  const likely = (c: string | null) => (c && OFTEN_SHARED.includes(c) ? 0 : 1);
  const months = [...Map.groupBy(rows, (t) => istDay(t.at).slice(0, 7))];
  const recent = <T extends { updated_at: string }>(xs: T[]) => [...xs].sort((a, b) => b.updated_at.localeCompare(a.updated_at));

  return (
    <main className="page narrow">
      <header className="top"><Link className="brand" href="/">Paisa</Link><Link className="link" href="/">← Dashboard</Link></header>
      {sp.done !== undefined ? (
        <p className={`nudge static${one(sp.failed) !== "0" ? "" : " ok"}`}>
          Posted {one(sp.done)} expense{one(sp.done) === "1" ? "" : "s"} to Splitwise.{one(sp.failed) !== "0" ? ` ${one(sp.failed)} failed and are still in the list below.` : ""}
        </p>
      ) : null}
      <form method="get" action="/backfill">
        <section className="card bar sticky">
          <div>
            <h2>Past payments to split</h2>
            <p className="muted">Tick the ones you shared, choose who with, then preview. Up to {MAX_BATCH} at a time; nothing is posted until you confirm.</p>
          </div>
          {sw ? <>
            <select name="target" className="pill" required aria-label="Split with" defaultValue="">
              <option value="" disabled>Split equally with…</option>
              <optgroup label="Groups">{recent(sw.groups).map((g) => <option key={g.id} value={`g:${g.id}`}>{g.name} ({g.members.length})</option>)}</optgroup>
              <optgroup label="Friends">{recent(sw.friends).map((f) => <option key={f.id} value={`f:${f.id}`}>{swName(f)} {f.last_name ?? ""}</option>)}</optgroup>
            </select>
            <button className="btn">Preview</button>
          </> : <p className="alert">{env("SPLITWISE_API_KEY") ? "Splitwise did not answer. Reload to try again." : "Add SPLITWISE_API_KEY to choose who to split with."}</p>}
        </section>

        {!rows.length ? <section className="card"><p className="muted">No imported payments are waiting. Import statements with <code>scripts/import-statements.ts</code> first.</p></section> : null}
        {months.map(([month, items]) => (
          <section className="card" key={month}>
            <h2>{new Date(`${month}-15T00:00:00Z`).toLocaleDateString("en-IN", { month: "long", year: "numeric" })} · {items.length} payment{items.length > 1 ? "s" : ""}</h2>
            <ul className="txns pick">
              {items.toSorted((a, b) => likely(a.category) - likely(b.category) || b.amount - a.amount).map((t) => (
                <li key={t.id}>
                  <label>
                    <input type="checkbox" name="pick" value={t.id} />
                    <span className="who"><span>{t.payee}</span><small className="muted">{new Date(t.at).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" })} · {t.account}</small></span>
                  </label>
                  <span className="tag">{t.category ?? "Unlabelled"}</span>
                  <span className="num amt">{rupees(t.amount)}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </form>
    </main>
  );
}
