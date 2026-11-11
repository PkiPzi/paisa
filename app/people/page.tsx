import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { istDay, rupees } from "@/lib/money";

export const dynamic = "force-dynamic";

export default async function People() {
  const db = getDb();
  const [people, lines, circles] = await Promise.all([
    db.select().from(schema.people),
    db.select().from(schema.dues).orderBy(desc(schema.dues.at)),
    db.select().from(schema.circles),
  ]);
  const byPerson = Map.groupBy(lines, (d) => d.personId);
  const rows = people
    .map((p) => ({ ...p, lines: byPerson.get(p.id) ?? [], net: (byPerson.get(p.id) ?? []).reduce((a, d) => a + d.amount, 0) }))
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
  const name = (id: number) => people.find((p) => p.id === id)?.name ?? "?";

  return (
    <main className="page narrow">
      <header className="top"><Link className="brand" href="/">Paisa</Link><Link className="link" href="/">← Dashboard</Link></header>

      {!rows.length ? (
        <section className="card"><h2>People</h2><p className="muted">Nobody yet. Split a payment in Telegram, or send the bot <code>/group Flat: Aman, Riya</code> or <code>Aman owes 500 dinner</code>.</p></section>
      ) : rows.map((p) => (
        <details className="card person" key={p.id}>
          <summary>
            <span className="who"><span>{p.name}</span><small className="muted">{p.net === 0 ? "Settled up" : p.net > 0 ? "owes you" : "you owe"}</small></span>
            <span className={`big num${p.net < 0 ? " down" : ""}`}>{rupees(Math.abs(p.net))}</span>
          </summary>
          <ul className="txns">
            {p.lines.map((d) => (
              <li key={d.id}>
                <div className="who"><span>{d.note}</span><small className="muted">{istDay(d.at)}</small></div>
                <span />
                <span className={`num amt${d.amount < 0 ? " in" : ""}`}>{d.amount < 0 ? "−" : "+"}{rupees(Math.abs(d.amount))}</span>
              </li>
            ))}
          </ul>
        </details>
      ))}

      {circles.length ? (
        <section className="card">
          <h2>Groups</h2>
          <ul className="rows">
            {circles.map((c) => <li key={c.id}><span>{c.name}</span><span className="muted">You, {(JSON.parse(c.memberIds) as number[]).map(name).join(", ")}</span></li>)}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
