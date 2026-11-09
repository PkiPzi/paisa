// The core loop: a forwarded mail becomes a labelled transaction, and the Telegram bot asks only when it must.
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { parseEmail } from "./parse";
import { CREDIT, DEBIT_OTHER, SPEND, equalShares, parseShares, rupees } from "./money";
import { esc, guessCategory, swCreateExpense, swFriends, swGroups, swMe, swName, tg, tgEdit, tgSend, type Keyboard } from "./clients";

const { emails, txns, payees, receipts, bills } = schema;
type Txn = typeof txns.$inferSelect;

const RECEIPT_WINDOW = sql`interval '45 minutes'`;
const AI_SILENT_AT = 0.8; // below this the bot asks instead of trusting the guess
const isSpend = (c: string | null) => c !== null && (SPEND as readonly string[]).includes(c);
const rows = <T,>(items: T[], n: number) => items.reduce<T[][]>((acc, x, i) => (i % n ? acc[acc.length - 1].push(x) : acc.push([x]), acc), []);

// ---------- ingest ----------
export type Mail = { id: string; from: string; subject: string; date: string; text: string };

export async function ingestEmail(m: Mail): Promise<string> {
  const db = getDb();
  const at = new Date(m.date);
  const p = parseEmail(m);
  const fresh = await db.insert(emails)
    .values({ id: m.id, sender: m.from, subject: m.subject, receivedAt: at, body: m.text.slice(0, 20000), kind: p.kind })
    .onConflictDoNothing().returning({ id: emails.id });
  if (!fresh.length) return "duplicate";

  if (p.kind === "bill") await db.insert(bills).values({ emailId: m.id, card: p.card, amount: p.amount, dueDate: p.dueDate });

  if (p.kind === "receipt") {
    await db.insert(receipts).values({ emailId: m.id, merchant: p.merchant, category: p.category, amount: p.amount, at });
    // The receipt may arrive after the bank alert: label the debit that is still unanswered or only guessed.
    const [hit] = await db.update(txns).set({ category: p.category, source: "receipt", payee: sql`${txns.payee} || ${` (${p.merchant})`}` })
      .where(and(eq(txns.direction, "debit"), eq(txns.amount, p.amount), or(isNull(txns.category), eq(txns.source, "ai")),
        sql`${txns.at} between ${at.toISOString()}::timestamptz - ${RECEIPT_WINDOW} and ${at.toISOString()}::timestamptz + ${RECEIPT_WINDOW}`))
      .returning();
    if (hit?.tgMessageId) await show(hit);
  }

  if (p.kind === "txn") {
    const known = p.payeeKey === "unknown" ? undefined : (await db.select().from(payees).where(eq(payees.key, p.payeeKey)))[0];
    let category: string | null = null, source: string | null = null, payee = p.payee;
    if (p.direction === "debit" && /credit ?card|\bcred\b/i.test(p.payee)) [category, source] = ["Card bill", "rule"];
    else if (known?.category) [category, source] = [known.category, "memory"];
    else {
      const [r] = p.direction === "debit" ? await db.select().from(receipts).where(and(eq(receipts.amount, p.amount),
        sql`${receipts.at} between ${at.toISOString()}::timestamptz - ${RECEIPT_WINDOW} and ${at.toISOString()}::timestamptz + ${RECEIPT_WINDOW}`)) : [];
      if (r) [category, source, payee] = [r.category, "receipt", `${p.payee} (${r.merchant})`];
      else {
        const g = await guessCategory({ payee: p.payee, amount: p.amount, direction: p.direction, at });
        if (g && g.confidence >= AI_SILENT_AT) [category, source] = [g.category, "ai"];
      }
    }
    const [t] = await db.insert(txns)
      .values({ emailId: m.id, at, amount: p.amount, direction: p.direction, account: p.account, payee, payeeKey: p.payeeKey, category, source })
      .returning();
    // Ask when unlabelled; offer the usual split when this payee is normally shared. Everything else stays silent.
    if (!category || (known?.splitTarget && p.direction === "debit")) await show(t);
  }
  return p.kind;
}

// ---------- the Telegram card for one transaction ----------
async function card(t: Txn): Promise<{ html: string; keyboard: Keyboard }> {
  const when = t.at.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const lines = [`<b>${rupees(t.amount)}</b> ${t.direction === "debit" ? "to" : "from"} ${esc(t.payee)}`, `${esc(t.account)} · ${when}`];
  const keyboard: Keyboard = [];
  if (!t.category) {
    lines.push("What was this?");
    const cats = t.direction === "debit" ? [...SPEND, ...DEBIT_OTHER] : CREDIT;
    keyboard.push(...rows(cats.map((c) => ({ text: c, callback_data: `c|${t.id}|${c}` })), 3));
  } else lines.push(`✓ ${t.category}${t.source === "ai" ? " (guessed)" : ""}`);

  if (t.splitwiseId && t.splitwiseId !== "pending") lines.push(`➗ Split with ${esc(t.splitWith ?? "")} · your share ${rupees(t.myShare ?? t.amount)}`);
  else if (t.direction === "debit" && (!t.category || isSpend(t.category))) {
    const [known] = await getDb().select().from(payees).where(eq(payees.key, t.payeeKey));
    const split = [{ text: known?.splitTarget ? "➗ Someone else" : "➗ Split", callback_data: `s|${t.id}` }];
    if (known?.splitTarget) split.unshift({ text: `➗ Split with ${known.splitLabel}`, callback_data: `t|${t.id}|${known.splitTarget}` });
    keyboard.push(split);
  }
  if (t.category) keyboard.push([{ text: "↩ Change label", callback_data: `u|${t.id}` }]);
  return { html: lines.join("\n"), keyboard };
}

/** Sends the card, or redraws it in place when it is already in the chat. */
async function show(t: Txn, extra?: { note?: string; keyboard?: Keyboard }) {
  const c = await card(t);
  const html = extra?.note ? `${c.html}\n\n${extra.note}` : c.html;
  const keyboard = extra?.keyboard ?? c.keyboard;
  if (t.tgMessageId) return void (await tgEdit(t.tgMessageId, html, keyboard));
  const id = await tgSend(html, keyboard);
  if (id) await getDb().update(txns).set({ tgMessageId: id }).where(eq(txns.id, t.id));
}

// ---------- labelling and splitting ----------
export async function setCategory(id: number, category: string | null) {
  const db = getDb();
  const [t] = await db.update(txns).set({ category, source: category ? "user" : null }).where(eq(txns.id, id)).returning();
  if (!t) return;
  if (category && t.payeeKey !== "unknown")
    await db.insert(payees).values({ key: t.payeeKey, category }).onConflictDoUpdate({ target: payees.key, set: { category } });
  if (t.tgMessageId) await show(t);
}

type Sw = { me: Awaited<ReturnType<typeof swMe>>; groups: Awaited<ReturnType<typeof swGroups>>; friends: Awaited<ReturnType<typeof swFriends>> };
type Plan = { groupId: number; owed: { userId: number; amount: number }[]; label: string };

export async function loadSplitwise(): Promise<Sw> {
  const [me, groups, friends] = await Promise.all([swMe(), swGroups(), swFriends()]);
  return { me, groups, friends };
}

/** Equal shares for a target ("g:<groupId>" or "f:<friendId>"), you first. Null when the target no longer exists. */
export function equalPlan(sw: Sw, target: string, amount: number): Plan | null {
  const [kind, rawId] = target.split(":");
  const g = kind === "g" ? sw.groups.find((x) => String(x.id) === rawId) : undefined;
  const f = kind === "f" ? sw.friends.find((x) => String(x.id) === rawId) : undefined;
  if (!g && !f) return null;
  const ids = [sw.me.id, ...(g ? g.members.map((m) => m.id).filter((id) => id !== sw.me.id) : [f!.id])];
  const shares = equalShares(amount, ids.length);
  return { groupId: g?.id ?? 0, owed: ids.map((userId, i) => ({ userId, amount: shares[i] })), label: g?.name ?? swName(f!) };
}

/**
 * Posts the expense to Splitwise once, even on a double tap, then records your share and the payee's habit.
 * Returns the updated transaction, or an error message; "" means it was already split.
 */
export async function postSplit(t: Txn, meId: number, plan: Plan, target?: string): Promise<Txn | string> {
  const db = getDb();
  // Claim first: Splitwise notifies friends, so a second tap must not post a second expense.
  const [claimed] = await db.update(txns).set({ splitwiseId: "pending" }).where(and(eq(txns.id, t.id), isNull(txns.splitwiseId))).returning();
  if (!claimed) return "";
  try {
    const swId = await swCreateExpense({ cost: t.amount, description: t.payee.slice(0, 60), date: t.at, groupId: plan.groupId, meId, owed: plan.owed });
    const myShare = plan.owed.find((o) => o.userId === meId)?.amount ?? 0;
    const [done] = await db.update(txns).set({ splitwiseId: swId, myShare, splitWith: plan.label }).where(eq(txns.id, t.id)).returning();
    if (target && t.payeeKey !== "unknown")
      await db.insert(payees).values({ key: t.payeeKey, splitTarget: target, splitLabel: plan.label })
        .onConflictDoUpdate({ target: payees.key, set: { splitTarget: target, splitLabel: plan.label } });
    return done;
  } catch (e) {
    await db.update(txns).set({ splitwiseId: null }).where(eq(txns.id, t.id));
    return `Splitwise did not accept it: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** Bot side: post, then redraw the card with the result or the error. */
async function splitAndShow(t: Txn, meId: number, plan: Plan, target?: string) {
  const r = await postSplit(t, meId, plan, target);
  if (r === "") return;
  return typeof r === "string" ? show(t, { note: `⚠️ ${esc(r)}` }) : show(r);
}

async function splitEqually(t: Txn, target: string) {
  const sw = await loadSplitwise();
  const plan = equalPlan(sw, target, t.amount);
  return plan ? splitAndShow(t, sw.me.id, plan, target) : show(t, { note: "⚠️ That Splitwise group or friend no longer exists." });
}

/** A typed reply to a card, e.g. "me 300, Aman 500". */
async function splitByReply(t: Txn, text: string) {
  const parts = parseShares(text);
  if (!parts) return tgSend("To split unevenly, reply to the payment with amounts, for example: <code>me 300, Aman 500</code>");
  const total = parts.reduce((a, p) => a + p.amount, 0);
  if (total !== t.amount) return tgSend(`Those add up to ${rupees(total)}, but the payment was ${rupees(t.amount)}.`);
  const [me, friends] = await Promise.all([swMe(), swFriends()]);
  const owed: { userId: number; amount: number }[] = [];
  for (const p of parts) {
    if (p.name === "me" || p.name === "i") { owed.push({ userId: me.id, amount: p.amount }); continue; }
    const hits = friends.filter((f) => `${f.first_name ?? ""} ${f.last_name ?? ""}`.toLowerCase().startsWith(p.name));
    if (hits.length !== 1) return tgSend(hits.length ? `More than one Splitwise friend matches "${esc(p.name)}". Add the surname.` : `No Splitwise friend is called "${esc(p.name)}".`);
    owed.push({ userId: hits[0].id, amount: p.amount });
  }
  if (!owed.some((o) => o.userId === me.id)) owed.unshift({ userId: me.id, amount: 0 });
  const label = parts.filter((p) => p.name !== "me" && p.name !== "i").map((p) => p.name[0].toUpperCase() + p.name.slice(1)).join(", ");
  return splitAndShow(t, me.id, { groupId: 0, owed, label });
}

async function showSplitTargets(t: Txn) {
  const [groups, friends] = await Promise.all([swGroups(), swFriends()]);
  const recent = <T extends { updated_at: string }>(xs: T[]) => [...xs].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 4);
  const buttons = [
    ...recent(groups).map((g) => ({ text: `👥 ${g.name}`, callback_data: `t|${t.id}|g:${g.id}` })),
    ...recent(friends).map((f) => ({ text: swName(f), callback_data: `t|${t.id}|f:${f.id}` })),
  ];
  await show(t, {
    note: "Split equally with whom? For uneven shares, reply to this message, e.g. <code>me 300, Aman 500</code>",
    keyboard: [...rows(buttons, 2), [{ text: "← Back", callback_data: `b|${t.id}` }]],
  });
}

// ---------- Telegram webhook ----------
type Update = {
  message?: { chat: { id: number }; text?: string; reply_to_message?: { message_id: number } };
  callback_query?: { id: string; data?: string; message?: { chat: { id: number } } };
};

export async function handleUpdate(u: Update, allowedChatId: string) {
  const db = getDb();
  const cq = u.callback_query;
  if (cq) {
    await tg("answerCallbackQuery", { callback_query_id: cq.id }); // stops the button's loading spinner
    if (String(cq.message?.chat.id) !== allowedChatId || !cq.data) return;
    const [op, id, arg] = cq.data.split("|");
    const [t] = await db.select().from(txns).where(eq(txns.id, Number(id)));
    if (!t) return;
    if (op === "c" && arg) await setCategory(t.id, arg);
    else if (op === "u") await setCategory(t.id, null);
    else if (op === "s") await showSplitTargets(t);
    else if (op === "t" && arg) await splitEqually(t, arg);
    else if (op === "b") await show(t);
    return;
  }
  const msg = u.message;
  if (!msg?.text || String(msg.chat.id) !== allowedChatId) return;
  const replyTo = msg.reply_to_message?.message_id;
  const [t] = replyTo ? await db.select().from(txns).where(eq(txns.tgMessageId, replyTo)) : [];
  if (t) await splitByReply(t, msg.text);
  else await tgSend("I message you when a payment needs a label. Tap a button to label or split it, or reply to a payment with shares like <code>me 300, Aman 500</code>.");
}
