"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { isValidSession, SESSION_COOKIE } from "@/lib/auth";
import { ALL } from "@/lib/money";
import { setCategory, setTag } from "@/lib/bot";
import { addDue, equalPlan, findOrCreatePerson, postSplit, resplit, settle, targetOf, undoSplit } from "@/lib/ledger";

export async function relabel(id: number, category: string) {
  // Server actions are public endpoints, so the session is checked here and not only by the page guard.
  if (!isValidSession((await cookies()).get(SESSION_COOKIE)?.value)) throw new Error("not signed in");
  if (!Number.isInteger(id) || (category !== "" && !ALL.includes(category))) throw new Error("bad input");
  await setCategory(id, category || null);
  revalidatePath("/");
}

/** Add (equal split), edit (exact shares) or remove a split. Used by the dashboard and the groups page. */
export async function editSplit(form: FormData) {
  if (!isValidSession((await cookies()).get(SESSION_COOKIE)?.value)) throw new Error("not signed in");
  const back = String(form.get("back"));
  const [txnId, target, op] = [Number(form.get("txn")), String(form.get("target")), String(form.get("op"))];
  const [t] = await getDb().select().from(schema.txns).where(eq(schema.txns.id, txnId));
  const who = await targetOf(target);
  if (!/^\/(groups)?(\?[\w=&%.-]*)?$/.test(back) || !t || !who) redirect("/");
  let err: string | null = null;
  if (op === "settle") {
    if (t.category !== "Settle-up" || !(await settle(t, await findOrCreatePerson(who.label)))) err = "That payment is already settled, or is not labelled Settle-up.";
  } else if (op === "add") {
    const plan = await equalPlan(target, t.amount);
    if (t.direction !== "debit" || !plan || !(await postSplit(t, plan))) err = "That payment is already split.";
  } else if (t.splitWith !== who.label) err = "That split has changed. Reload and try again.";
  else if (op === "remove") await undoSplit(t);
  else {
    const rupees = (k: string) => Math.round(Number(form.get(k)) * 100);
    err = await resplit(t, who.label, rupees("me"), who.ids.map((personId) => ({ personId, amount: rupees(`p${personId}`) })));
  }
  const url = new URL(back, "http://x");
  if (err) url.searchParams.set("err", err);
  redirect(url.pathname + url.search);
}

/** A payment with no bank record (cash, or a transfer you will not import): "Ratnashree gave me 5000". */
export async function recordSettle(form: FormData) {
  if (!isValidSession((await cookies()).get(SESSION_COOKIE)?.value)) throw new Error("not signed in");
  const name = String(form.get("name") ?? "").trim();
  const paise = Math.round(Number(form.get("amount")) * 100);
  if (!name || !Number.isFinite(paise) || paise <= 0) redirect("/people?err=" + encodeURIComponent("Enter a name and an amount above zero."));
  const gave = form.get("dir") === "in"; // they paid you: their dues shrink
  await addDue(name, gave ? -paise : paise, String(form.get("note") ?? "").trim().slice(0, 80) || "Settle-up");
  redirect("/people");
}

/** A free-text label on one payment; it is also remembered for the payee, so the next payment gets it too. */
export async function setLabel(id: number, tag: string) {
  if (!isValidSession((await cookies()).get(SESSION_COOKIE)?.value)) throw new Error("not signed in");
  const [t] = Number.isInteger(id) ? await getDb().select().from(schema.txns).where(eq(schema.txns.id, id)) : [];
  if (!t) throw new Error("bad input");
  await setTag(t, tag.trim().replace(/\s+/g, " ").slice(0, 40) || null);
  revalidatePath("/");
  revalidatePath("/groups");
}
