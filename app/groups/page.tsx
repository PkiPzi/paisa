import Link from "next/link";
import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { DEBIT_OTHER, SPEND, istDay, rupees } from "@/lib/money";
import { groupTxns } from "@/lib/ledger";
import { CategorySelect } from "../category-select";
import { editSplit } from "../actions";
import { SplitEditor, splitContext } from "../split-editor";

export const dynamic = "force-dynamic";

export default async function Groups({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  const { err } = await searchParams;
  const db = getDb();
  const [people, circles, recent] = await Promise.all([
    db.select().from(schema.people),
    db.select().from(schema.circles).orderBy(desc(schema.circles.id)),
    db.select().from(schema.txns) // unsplit payments that can still be added to a group
      .where(and(eq(schema.txns.direction, "debit"), isNull(schema.txns.myShare), isNull(schema.txns.splitWith), gte(schema.txns.at, new Date(Date.now() - 60 * 86_400_000))))
      .orderBy(desc(schema.txns.at)).limit(80),
  ]);
  const name = new Map(people.map((p) => [p.id, p.name]));
  const groups = await Promise.all(circles.map(async (c) => ({ ...c, ids: JSON.parse(c.memberIds) as number[], items: await groupTxns(c.name) })));
  const ctx = await splitContext(groups.flatMap((g) => g.items));

  return (
    <main className="page narrow">
      <header className="top"><Link className="brand" href="/">Paisa</Link><Link className="link" href="/">← Dashboard</Link></header>
      {err ? <p className="nudge static">{err}</p> : null}
      {!groups.length ? <section className="card"><h2>Groups</h2><p className="muted">No groups yet. Send the bot <code>/group Trip: Aman, Riya</code> to make one.</p></section> : null}
      {groups.map((g) => (
        <details className="card person" key={g.id} open>
          <summary>
            <span className="who"><span>{g.name}</span><small className="muted">You, {g.ids.map((i) => name.get(i)).join(", ")} · {g.items.length} payment{g.items.length === 1 ? "" : "s"}</small></span>
            <span className="big num">{rupees(g.items.reduce((a, t) => a + t.amount, 0))}</span>
          </summary>
          <ul className="txns">
            {g.items.map((t) => (
              <li key={t.id}>
                <div className="who"><span>{t.payee}</span><small className="muted">{istDay(t.at)} · your share {rupees(t.myShare ?? 0)}</small></div>
                <CategorySelect id={t.id} value={t.category} options={[...SPEND, ...DEBIT_OTHER]} />
                <span className="num amt">{rupees(t.amount)}</span>
                <SplitEditor t={t} ctx={ctx} back="/groups" />
              </li>
            ))}
          </ul>
          {recent.length ? (
            <form action={editSplit} style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
              <input type="hidden" name="target" value={`g:${g.id}`} /><input type="hidden" name="back" value="/groups" />
              <select name="txn" className="pill" style={{ maxWidth: "100%" }} aria-label="Add a payment" required defaultValue="">
                <option value="" disabled>Add a payment, split equally…</option>
                {recent.map((t) => <option key={t.id} value={t.id}>{istDay(t.at)} · {t.payee} · {rupees(t.amount)}</option>)}
              </select>
              <button className="btn ghost" name="op" value="add">Add</button>
            </form>
          ) : null}
        </details>
      ))}
    </main>
  );
}
