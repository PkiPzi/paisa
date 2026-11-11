import Link from "next/link";
import { and, desc, eq, gte, inArray, isNull, like, or } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { SPEND, istDay, rupees } from "@/lib/money";
import { equalPlan, splitTargets } from "@/lib/ledger";
import { postBackfill } from "./actions";
import { MAX_BATCH } from "./limits";

export const dynamic = "force-dynamic";

const { txns } = schema;
const MIN_AMOUNT = 10000; // ₹100: smaller payments are rarely worth splitting a year later
const OFTEN_SHARED = ["Food", "Groceries", "Travel", "Fun", "Rent", "Bills", "Ride"];
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function Backfill({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const target = one(sp.target);
  const picks = [sp.pick ?? []].flat().map(Number).filter(Number.isInteger).slice(0, MAX_BATCH);
  const db = getDb();

  const open = and(like(txns.emailId, "stmt:%"), eq(txns.direction, "debit"), isNull(txns.myShare));

  // Step 2: the preview of exactly what would be recorded.
  if (picks.length && target) {
    const chosen = await db.select().from(txns).where(and(open, inArray(txns.id, picks))).orderBy(desc(txns.at));
    const plans = [];
    for (const t of chosen) plans.push({ t, plan: await equalPlan(target, t.amount) });
    const first = plans[0]?.plan;
    const others = first?.dues.length ?? 0;
    const back = plans.reduce((a, p) => a + p.t.amount - (p.plan?.myShare ?? p.t.amount), 0);
    return (
      <main className="page narrow">
        <header className="top"><Link className="brand" href="/">Paisa</Link><Link className="link" href="/backfill">← Change selection</Link></header>
        <section className="card">
          <h2>Preview: nothing has been saved yet</h2>
          {!first ? <p className="alert">That group or person was not found.</p> : <>
            <p className="big">{rupees(back)}</p>
            <p className="muted">will be added to what <b>{first.label}</b> owe{others > 1 ? "" : "s"} you: {chosen.length} payment{chosen.length > 1 ? "s" : ""}, each split equally between you and {others} other{others > 1 ? "s" : ""}.</p>
            <ul className="txns">
              {plans.map(({ t, plan }) => (
                <li key={t.id}>
                  <div className="who"><span>{t.payee}</span><small className="muted">{istDay(t.at)} · {t.account} · others owe {rupees(plan!.dues[0]?.amount ?? 0)} each</small></div>
                  <span className="muted num">your share {rupees(plan!.myShare)}</span>
                  <span className="num amt">{rupees(t.amount)}</span>
                </li>
              ))}
            </ul>
            <form action={postBackfill} className="bar">
              <input type="hidden" name="target" value={target} />
              {chosen.map((t) => <input key={t.id} type="hidden" name="pick" value={t.id} />)}
              <Link className="btn ghost" href="/backfill">Cancel</Link>
              <button className="btn">Save {chosen.length} split{chosen.length > 1 ? "s" : ""}</button>
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
  const who = await splitTargets();

  return (
    <main className="page narrow">
      <header className="top"><Link className="brand" href="/">Paisa</Link><Link className="link" href="/">← Dashboard</Link></header>
      {sp.done !== undefined ? <p className="nudge static ok">Saved {one(sp.done)} split{one(sp.done) === "1" ? "" : "s"}. The amounts are now under Owed to you.</p> : null}
      <form method="get" action="/backfill">
        <section className="card bar sticky">
          <div>
            <h2>Past payments to split</h2>
            <p className="muted">Tick the ones you shared, choose who with, then preview. Nothing is saved until you confirm.</p>
          </div>
          {who.circles.length || who.people.length ? <>
            <select name="target" className="pill" required aria-label="Split with" defaultValue="">
              <option value="" disabled>Split equally with…</option>
              {who.circles.length ? <optgroup label="Groups">{who.circles.map((g) => <option key={g.id} value={`g:${g.id}`}>{g.name} ({g.size + 1})</option>)}</optgroup> : null}
              <optgroup label="People">{who.people.map((f) => <option key={f.id} value={`p:${f.id}`}>{f.name}</option>)}</optgroup>
            </select>
            <button className="btn">Preview</button>
          </> : <p className="alert">No groups yet. Send the bot <code>/group Flat: Aman, Riya</code> first.</p>}
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
