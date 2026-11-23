"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { isValidSession, SESSION_COOKIE } from "@/lib/auth";
import { equalPlan, postSplit, resplit, undoSplit } from "@/lib/ledger";

const { txns, circles } = schema;

/** One action for the three buttons: save custom shares, take a payment out of the group, or add one (equal split). */
export async function editGroupPayment(form: FormData) {
  if (!isValidSession((await cookies()).get(SESSION_COOKIE)?.value)) throw new Error("not signed in");
  const db = getDb();
  const [c] = await db.select().from(circles).where(eq(circles.id, Number(form.get("group"))));
  const [t] = await db.select().from(txns).where(eq(txns.id, Number(form.get("txn"))));
  if (!c || !t) redirect("/groups");
  const op = String(form.get("op"));
  let err: string | null = null;
  if (op === "add") {
    const plan = await equalPlan(`g:${c.id}`, t.amount);
    if (t.direction !== "debit" || !plan || !(await postSplit(t, plan))) err = "That payment is already split.";
  } else if (t.splitWith !== c.name) err = "That payment is no longer in this group.";
  else if (op === "remove") await undoSplit(t);
  else {
    const rupees = (k: string) => Math.round(Number(form.get(k)) * 100);
    err = await resplit(t, c.name, rupees("me"), (JSON.parse(c.memberIds) as number[]).map((personId) => ({ personId, amount: rupees(`p${personId}`) })));
  }
  redirect(`/groups${err ? `?err=${encodeURIComponent(err)}` : ""}`);
}
