import { inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { splitTargets } from "@/lib/ledger";
import { editSplit } from "./actions";

type Txn = typeof schema.txns.$inferSelect;
export type SplitContext = {
  targets: { circles: { id: number; name: string }[]; people: { id: number; name: string }[] };
  /** The current split's target ("g:<id>" / "p:<id>") when it can be edited, else null. */
  targetFor: (t: Txn) => { target: string; people: { id: number; name: string; owed: number }[] } | null;
};

/** "Split" on an unsplit payment, "Edit split" on a split one. Settle-ups and credits get nothing. */
export function SplitEditor({ t, ctx, back }: { t: Txn; ctx: SplitContext; back: string }) {
  const box = { style: { gridColumn: "1 / -1" } };
  const hidden = (
    <><input type="hidden" name="txn" value={t.id} /><input type="hidden" name="back" value={back} /></>
  );
  if (t.direction !== "debit") return null;

  if (t.myShare === null && t.splitWith === null) {
    const { circles, people } = ctx.targets;
    if (!circles.length && !people.length) return null;
    return (
      <details {...box}>
        <summary className="muted">Split</summary>
        <form action={editSplit} style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
          {hidden}
          <select name="target" className="pill" required aria-label="Split equally with" defaultValue="">
            <option value="" disabled>Split equally with…</option>
            {circles.length ? <optgroup label="Groups">{circles.map((g) => <option key={g.id} value={`g:${g.id}`}>{g.name}</option>)}</optgroup> : null}
            {people.length ? <optgroup label="People">{people.map((p) => <option key={p.id} value={`p:${p.id}`}>{p.name}</option>)}</optgroup> : null}
          </select>
          <button className="btn ghost" name="op" value="add">Split</button>
        </form>
      </details>
    );
  }

  const cur = t.myShare === null ? null : ctx.targetFor(t);
  if (!cur) return null;
  return (
    <details {...box}>
      <summary className="muted">Edit split</summary>
      <form action={editSplit} style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "end", marginTop: 8 }}>
        {hidden}<input type="hidden" name="target" value={cur.target} />
        {[{ k: "me", label: "You", v: t.myShare ?? 0 }, ...cur.people.map((p) => ({ k: `p${p.id}`, label: p.name, v: p.owed }))].map((f) => (
          <label key={f.k} className="muted" style={{ display: "grid", gap: 2, fontSize: 13 }}>{f.label}
            <input className="pill" style={{ width: "7em" }} name={f.k} type="number" min="0" step="0.01" defaultValue={f.v / 100} />
          </label>
        ))}
        <button className="btn" name="op" value="save">Save</button>
        <button className="btn ghost" name="op" value="remove">Remove split</button>
      </form>
    </details>
  );
}

/** Everything the editor needs for these payments, in three queries. */
export async function splitContext(ts: Txn[]): Promise<SplitContext> {
  const db = getDb();
  const ids = ts.filter((t) => t.myShare !== null).map((t) => t.id);
  const [targets, circles, people, lines] = await Promise.all([
    splitTargets(), db.select().from(schema.circles), db.select().from(schema.people),
    ids.length ? db.select().from(schema.dues).where(inArray(schema.dues.txnId, ids)) : [],
  ]);
  const owed = (txn: number, person: number) => lines.filter((d) => d.txnId === txn && d.personId === person).reduce((a, d) => a + d.amount, 0);
  return {
    targets,
    targetFor: (t) => {
      const c = circles.find((x) => x.name === t.splitWith);
      const p = people.find((x) => x.name === t.splitWith);
      const members = c ? (JSON.parse(c.memberIds) as number[]).flatMap((i) => people.find((x) => x.id === i) ?? []) : p ? [p] : null;
      return members ? { target: c ? `g:${c.id}` : `p:${p!.id}`, people: members.map((m) => ({ ...m, owed: owed(t.id, m.id) })) } : null;
    },
  };
}
