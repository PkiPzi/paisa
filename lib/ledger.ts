// The built-in "who owes whom" ledger: people, circles (named groups) and dues.
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { equalShares } from "./money";

const { people, circles, dues, txns, payees } = schema;
type Txn = typeof txns.$inferSelect;
export type Person = typeof people.$inferSelect;

// ---------- pure ----------
export type Command =
  | { kind: "who" }
  | { kind: "group"; name: string; members: string[] }
  | { kind: "due"; person: string; amount: number; note: string } // amount > 0: they owe you
  | { kind: "cash"; amount: number; note: string }
  | { kind: "merge"; from: string; to: string };

const cap = (s: string) => s.trim().replace(/\s+/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase());

/**
 * "/who", "/group Flat: Aman, Riya", "Aman owes 500 dinner", "owe Aman 500 cab",
 * "spent 200 chai" (a cash payment), "/merge Ratna into Ratnashree". Null for anything else.
 */
export function parseCommand(text: string): Command | null {
  const t = text.trim();
  if (/^\/who\b/i.test(t)) return { kind: "who" };
  const g = /^\/group\s+([^:]+):\s*(.+)$/i.exec(t);
  if (g) {
    const members = g[2].split(",").map(cap).filter(Boolean);
    return members.length ? { kind: "group", name: cap(g[1]), members } : null;
  }
  const cash = /^(?:spent|cash|paid)\s+₹?\s*(\d+(?:\.\d{1,2})?)(?:\s+(?:on|for|at)\b)?\s*(.*)$/i.exec(t);
  if (cash) return { kind: "cash", amount: Math.round(Number(cash[1]) * 100), note: cash[2].trim() };
  const merge = /^\/merge\s+(.+?)\s+into\s+(.+)$/i.exec(t);
  if (merge) return { kind: "merge", from: cap(merge[1]), to: cap(merge[2]) };
  const theyOwe = /^([A-Za-z][A-Za-z .]*?)\s+owes?(?:\s+me)?\s+₹?\s*(\d+(?:\.\d{1,2})?)\s*(.*)$/i.exec(t);
  if (theyOwe) return { kind: "due", person: cap(theyOwe[1]), amount: Math.round(Number(theyOwe[2]) * 100), note: theyOwe[3].trim() || "Added by hand" };
  const iOwe = /^(?:i\s+)?owe\s+([A-Za-z][A-Za-z .]*?)\s+₹?\s*(\d+(?:\.\d{1,2})?)\s*(.*)$/i.exec(t);
  if (iOwe) return { kind: "due", person: cap(iOwe[1]), amount: -Math.round(Number(iOwe[2]) * 100), note: iOwe[3].trim() || "Added by hand" };
  return null;
}

// ---------- people and circles ----------
/** Names match without regard to case; an unknown name becomes a new person. */
export async function findOrCreatePerson(name: string): Promise<Person> {
  const db = getDb();
  const clean = cap(name);
  const [hit] = await db.select().from(people).where(sql`lower(${people.name}) = ${clean.toLowerCase()}`);
  if (hit) return hit;
  const [made] = await db.insert(people).values({ name: clean }).onConflictDoNothing().returning();
  return made ?? (await db.select().from(people).where(eq(people.name, clean)))[0];
}

/** Folds one person into another (same friend under two names). Null when either name is unknown. */
export async function mergePeople(fromName: string, toName: string): Promise<Person | null> {
  const db = getDb();
  const find = async (n: string) => (await db.select().from(people).where(sql`lower(${people.name}) = ${n.toLowerCase()}`))[0];
  const [from, to] = [await find(fromName), await find(toName)];
  if (!from || !to || from.id === to.id) return null;
  await db.update(dues).set({ personId: to.id }).where(eq(dues.personId, from.id));
  for (const c of await db.select().from(circles)) {
    const ids = JSON.parse(c.memberIds) as number[];
    if (ids.includes(from.id))
      await db.update(circles).set({ memberIds: JSON.stringify([...new Set(ids.map((i) => (i === from.id ? to.id : i)))]) }).where(eq(circles.id, c.id));
  }
  await db.update(payees).set({ splitTarget: `p:${to.id}`, splitLabel: to.name }).where(eq(payees.splitTarget, `p:${from.id}`));
  await db.update(txns).set({ splitWith: to.name }).where(eq(txns.splitWith, from.name));
  await db.delete(people).where(eq(people.id, from.id)); // last, so a failure above leaves both people in place
  return to;
}

export async function saveCircle(name: string, memberNames: string[]) {
  const ids = [];
  for (const n of memberNames) ids.push((await findOrCreatePerson(n)).id);
  const memberIds = JSON.stringify([...new Set(ids)]);
  await getDb().insert(circles).values({ name, memberIds }).onConflictDoUpdate({ target: circles.name, set: { memberIds } });
  return ids.length;
}

/** Everyone you can split with: circles first, then people, most recently used first. */
export async function splitTargets() {
  const db = getDb();
  const [cs, ps] = await Promise.all([
    db.select().from(circles).orderBy(desc(circles.id)),
    db.select({ id: people.id, name: people.name, last: sql<string | null>`max(${dues.at})` }).from(people)
      .leftJoin(dues, eq(dues.personId, people.id)).groupBy(people.id, people.name).orderBy(sql`max(${dues.at}) desc nulls last`),
  ]);
  return { circles: cs.map((c) => ({ id: c.id, name: c.name, size: (JSON.parse(c.memberIds) as number[]).length })), people: ps };
}

/** Net position per person in paise: positive = they owe you. Settled people are left out. */
export async function balances(): Promise<{ id: number; name: string; amount: number }[]> {
  const rows = await getDb().select({ id: people.id, name: people.name, amount: sql<number>`coalesce(sum(${dues.amount}), 0)::int` })
    .from(people).leftJoin(dues, eq(dues.personId, people.id)).groupBy(people.id, people.name);
  return rows.filter((r) => r.amount !== 0).sort((a, b) => b.amount - a.amount);
}

// ---------- splitting a payment ----------
export type Plan = { label: string; myShare: number; dues: { personId: number; amount: number }[] };

/** Equal shares with a target ("g:<circleId>" or "p:<personId>"), you included. Null when the target is gone. */
export async function equalPlan(target: string, amount: number): Promise<Plan | null> {
  const db = getDb();
  const [kind, rawId] = target.split(":");
  const id = Number(rawId);
  let ids: number[], label: string;
  if (kind === "g") {
    const [c] = await db.select().from(circles).where(eq(circles.id, id));
    if (!c) return null;
    [ids, label] = [JSON.parse(c.memberIds) as number[], c.name];
  } else {
    const [p] = await db.select().from(people).where(eq(people.id, id));
    if (!p) return null;
    [ids, label] = [[p.id], p.name];
  }
  if (!ids.length) return null;
  const [mine, ...theirs] = equalShares(amount, ids.length + 1);
  return { label, myShare: mine, dues: ids.map((personId, i) => ({ personId, amount: theirs[i] })) };
}

/** Records a split once, even on a double tap. Returns the updated payment, or null if it was already split. */
export async function postSplit(t: Txn, plan: Plan, target?: string): Promise<Txn | null> {
  const db = getDb();
  // Claim first so two taps cannot both add dues (the database driver has no transactions).
  const [claimed] = await db.update(txns).set({ myShare: plan.myShare, splitWith: plan.label })
    .where(and(eq(txns.id, t.id), isNull(txns.myShare), isNull(txns.splitWith))).returning();
  if (!claimed) return null;
  try {
    const owed = plan.dues.filter((d) => d.amount > 0);
    if (owed.length) await db.insert(dues).values(owed.map((d) => ({ ...d, note: t.payee, at: t.at, txnId: t.id })));
  } catch (e) {
    await db.update(txns).set({ myShare: null, splitWith: null }).where(eq(txns.id, t.id));
    throw e;
  }
  if (target && t.payeeKey !== "unknown")
    await db.insert(payees).values({ key: t.payeeKey, splitTarget: target, splitLabel: plan.label })
      .onConflictDoUpdate({ target: payees.key, set: { splitTarget: target, splitLabel: plan.label } });
  return claimed;
}

/** Removes a split or settle-up and its ledger lines. */
export async function undoSplit(t: Txn): Promise<Txn> {
  const db = getDb();
  await db.delete(dues).where(eq(dues.txnId, t.id));
  const [back] = await db.update(txns).set({ myShare: null, splitWith: null }).where(eq(txns.id, t.id)).returning();
  return back;
}

/** A transfer to or from a friend: money in clears what they owed you, money out clears what you owed them. */
export async function settle(t: Txn, person: Person): Promise<Txn | null> {
  const db = getDb();
  const [claimed] = await db.update(txns).set({ splitWith: person.name }).where(and(eq(txns.id, t.id), isNull(txns.splitWith))).returning();
  if (!claimed) return null;
  await db.insert(dues).values({ personId: person.id, amount: t.direction === "credit" ? -t.amount : t.amount, note: "Settle-up", at: t.at, txnId: t.id });
  if (t.payeeKey !== "unknown")
    await db.insert(payees).values({ key: t.payeeKey, category: "Settle-up", splitTarget: `p:${person.id}`, splitLabel: person.name })
      .onConflictDoUpdate({ target: payees.key, set: { category: "Settle-up", splitTarget: `p:${person.id}`, splitLabel: person.name } });
  return claimed;
}

export async function addDue(personName: string, amount: number, note: string) {
  const p = await findOrCreatePerson(personName);
  await getDb().insert(dues).values({ personId: p.id, amount, note, at: new Date() });
  return p;
}
