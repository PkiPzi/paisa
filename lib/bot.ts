// The core loop: a forwarded mail becomes a labelled transaction, and the Telegram bot asks only when it must.
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { parseEmail } from "./parse";
import { CREDIT, DEBIT_OTHER, SPEND, parseShares, rupees } from "./money";
import { esc, guessCategory, tg, tgEdit, tgSend, type Keyboard } from "./clients";
import { addDue, balances, equalPlan, findOrCreatePerson, parseCommand, postSplit, saveCircle, settle, splitTargets, undoSplit } from "./ledger";

const { emails, txns, payees, receipts, bills, people } = schema;
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
    if (category === "Settle-up" && known?.splitTarget?.startsWith("p:")) {
      // A friend you have settled with before: the ledger is updated without asking.
      const [friend] = await db.select().from(people).where(eq(people.id, Number(known.splitTarget.slice(2))));
      if (friend) await settle(t, friend);
      else await show(t);
    }
    // Ask when unlabelled; offer the usual split when this payee is normally shared. Everything else stays silent.
    else if (!category || (known?.splitTarget && p.direction === "debit")) await show(t);
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

  if (t.category === "Settle-up") {
    if (t.splitWith) {
      lines.push(`🤝 Settled with ${esc(t.splitWith)}`);
      keyboard.push([{ text: "↩ Undo", callback_data: `x|${t.id}` }]);
    } else {
      lines.push("Who was this with? Tap a name, or reply with one.");
      const { people: ps } = await splitTargets();
      keyboard.push(...rows(ps.slice(0, 8).map((p) => ({ text: p.name, callback_data: `w|${t.id}|${p.id}` })), 2));
    }
  } else if (t.myShare !== null) {
    lines.push(`➗ Split with ${esc(t.splitWith ?? "")} · your share ${rupees(t.myShare)}`);
    keyboard.push([{ text: "↩ Undo split", callback_data: `x|${t.id}` }]);
  } else if (t.direction === "debit" && (!t.category || isSpend(t.category))) {
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

async function splitEqually(t: Txn, target: string) {
  const plan = await equalPlan(target, t.amount);
  if (!plan) return show(t, { note: "⚠️ That group or person no longer exists." });
  const done = await postSplit(t, plan, target);
  if (done) await show(done);
}

/** A typed reply to a payment card: shares such as "me 300, Aman 500", or a name for a settle-up. */
async function handleReply(t: Txn, text: string) {
  if (t.category === "Settle-up") {
    const done = await settle(t, await findOrCreatePerson(text));
    return done ? show(done) : undefined;
  }
  const parts = parseShares(text);
  if (!parts) return tgSend("To split unevenly, reply to the payment with amounts, for example: <code>me 300, Aman 500</code>");
  const total = parts.reduce((a, p) => a + p.amount, 0);
  if (total !== t.amount) return tgSend(`Those add up to ${rupees(total)}, but the payment was ${rupees(t.amount)}.`);
  const isMe = (n: string) => n === "me" || n === "i";
  const owed = [];
  for (const p of parts.filter((x) => !isMe(x.name))) owed.push({ personId: (await findOrCreatePerson(p.name)).id, amount: p.amount, name: p.name });
  const myShare = parts.filter((x) => isMe(x.name)).reduce((a, p) => a + p.amount, 0);
  const label = owed.map((o) => o.name[0].toUpperCase() + o.name.slice(1)).join(", ");
  const done = await postSplit(t, { label, myShare, dues: owed });
  if (done) await show(done);
}

async function showSplitTargets(t: Txn) {
  const { circles, people: ps } = await splitTargets();
  const buttons = [
    ...circles.slice(0, 4).map((g) => ({ text: `👥 ${g.name} (${g.size + 1})`, callback_data: `t|${t.id}|g:${g.id}` })),
    ...ps.slice(0, 6).map((p) => ({ text: p.name, callback_data: `t|${t.id}|p:${p.id}` })),
  ];
  await show(t, {
    note: buttons.length
      ? "Split equally with whom? For someone new or uneven shares, reply to this message, e.g. <code>me 300, Aman 500</code>"
      : "No one to split with yet. Reply to this message with shares, e.g. <code>me 300, Aman 500</code>, or create a group: <code>/group Flat: Aman, Riya</code>",
    keyboard: [...rows(buttons, 2), [{ text: "← Back", callback_data: `b|${t.id}` }]],
  });
}

async function whoOwes(): Promise<string> {
  const b = await balances();
  if (!b.length) return "All settled up. Nobody owes anything.";
  const line = (x: { name: string; amount: number }) => `• ${esc(x.name)} ${rupees(Math.abs(x.amount))}`;
  const [owed, owe] = [b.filter((x) => x.amount > 0), b.filter((x) => x.amount < 0)];
  return [
    ...(owed.length ? [`<b>Owed to you · ${rupees(owed.reduce((a, x) => a + x.amount, 0))}</b>`, ...owed.map(line)] : []),
    ...(owe.length ? [`<b>You owe · ${rupees(-owe.reduce((a, x) => a + x.amount, 0))}</b>`, ...owe.map(line)] : []),
  ].join("\n");
}

const HELP = [
  "I message you when a payment needs a label. Tap a button to label or split it, or reply to a payment with shares like <code>me 300, Aman 500</code>.",
  "",
  "<code>/who</code> — who owes whom",
  "<code>/group Flat: Aman, Riya</code> — make a group for one-tap splits",
  "<code>Aman owes 500 dinner</code> — add what someone owes you",
  "<code>owe Aman 500 cab</code> — add what you owe someone",
].join("\n");

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
    else if (op === "u") await setCategory((t.category === "Settle-up" ? await undoSplit(t) : t).id, null); // a settle-up cannot outlive its label
    else if (op === "s") await showSplitTargets(t);
    else if (op === "t" && arg) await splitEqually(t, arg);
    else if (op === "x") await show(await undoSplit(t));
    else if (op === "w" && arg) {
      const [person] = await db.select().from(people).where(eq(people.id, Number(arg)));
      const done = person && (await settle(t, person));
      if (done) await show(done);
    } else if (op === "b") await show(t);
    return;
  }
  const msg = u.message;
  if (!msg?.text || String(msg.chat.id) !== allowedChatId) return;
  const replyTo = msg.reply_to_message?.message_id;
  const [t] = replyTo ? await db.select().from(txns).where(eq(txns.tgMessageId, replyTo)) : [];
  if (t) return handleReply(t, msg.text);

  const cmd = parseCommand(msg.text);
  if (cmd?.kind === "who") await tgSend(await whoOwes());
  else if (cmd?.kind === "group") await tgSend(`👥 <b>${esc(cmd.name)}</b> saved with ${await saveCircle(cmd.name, cmd.members)} people. It now appears when you tap Split.`);
  else if (cmd?.kind === "due") {
    const p = await addDue(cmd.person, cmd.amount, cmd.note);
    const net = (await balances()).find((b) => b.id === p.id)?.amount ?? 0;
    await tgSend(`Noted. ${net === 0 ? `You and ${esc(p.name)} are settled up.` : net > 0 ? `${esc(p.name)} now owes you ${rupees(net)}.` : `You now owe ${esc(p.name)} ${rupees(-net)}.`}`);
  } else await tgSend(HELP);
}
