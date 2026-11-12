// The core loop: a forwarded mail becomes a labelled transaction, and the Telegram bot asks only when it must.
import { and, desc, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { parseEmail, payeeKeyOf } from "./parse";
import { ALL, CREDIT, DEBIT_OTHER, SPEND, istDay, parseShares, rupees, summarize } from "./money";
import { esc, guessCategory, tg, tgEdit, tgSend, type Keyboard } from "./clients";
import { addDue, balances, equalPlan, findOrCreatePerson, mergePeople, parseCommand, postSplit, saveCircle, settle, splitTargets, undoSplit } from "./ledger";

const { emails, txns, payees, receipts, bills, people } = schema;
type Txn = typeof txns.$inferSelect;

const RECEIPT_WINDOW = sql`interval '45 minutes'`;
const AI_SILENT_AT = 0.8; // below this the bot asks instead of trusting the guess
const WHY: Record<string, string> = { ai: " (guessed)", memory: " (same as last time)", receipt: " (from the receipt)", rule: " (automatic)" };
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
    // A bank may send both a mail and an SMS for one payment: the second channel to arrive is dropped.
    // shortcut: if both arrive in the same instant, both can be stored; add a unique key if that ever shows up.
    const sms = m.id.startsWith("sms:");
    const [twin] = await db.select({ id: txns.id }).from(txns).where(and(
      eq(txns.amount, p.amount), eq(txns.direction, p.direction),
      sql`split_part(${txns.account}, ' ', 1) = ${p.account.split(" ")[0]}`,
      sms ? sql`${txns.emailId} not like 'sms:%'` : sql`${txns.emailId} like 'sms:%'`,
      sql`${txns.at} between ${at.toISOString()}::timestamptz - interval '10 minutes' and ${at.toISOString()}::timestamptz + interval '10 minutes'`,
    )).limit(1);
    if (twin) return "duplicate";

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
      .values({ emailId: m.id, at, amount: p.amount, direction: p.direction, account: p.account, payee, payeeKey: p.payeeKey, category, source, tag: source === "memory" ? known?.tag ?? null : null })
      .returning();
    // Every payment gets a card, so you always see what was done and can change it with one tap.
    let shown = t;
    if (category === "Settle-up" && known?.splitTarget?.startsWith("p:")) {
      // A friend you have settled with before: the ledger is updated without asking.
      const [friend] = await db.select().from(people).where(eq(people.id, Number(known.splitTarget.slice(2))));
      if (friend) shown = (await settle(t, friend)) ?? t;
    }
    await show(shown);
  }
  return p.kind;
}

// ---------- the Telegram card for one transaction ----------
async function card(t: Txn): Promise<{ html: string; keyboard: Keyboard }> {
  const db = getDb();
  const day = (d: Date, o: Intl.DateTimeFormatOptions) => d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", ...o });
  const when = day(t.at, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  // Enough context to recognise the payment days later: the bank's reference, history with this payee, the day's total.
  const [mail] = t.emailId ? await db.select({ body: emails.body }).from(emails).where(eq(emails.id, t.emailId)) : [];
  const ref = /\b(?:UPI|Ref(?: ?no)?)[:. ]*(\d{9,})/i.exec(mail?.body ?? "")?.[1];
  const lines = [`<b>${rupees(t.amount)}</b> ${t.direction === "debit" ? "to" : "from"} ${esc(t.payee)}`, `${esc(t.account)} · ${when}${ref ? ` · ref ${ref}` : ""}`];
  if (t.payeeKey !== "unknown") {
    const before = await db.select().from(txns).where(and(eq(txns.payeeKey, t.payeeKey), eq(txns.direction, t.direction), lt(txns.at, t.at))).orderBy(desc(txns.at)).limit(20);
    const verb = t.direction === "debit" ? "payment" : "receipt";
    lines.push(before.length
      ? `${before.length === 20 ? "20+" : before.length} earlier ${verb}${before.length > 1 ? "s" : ""} · last ${rupees(before[0].amount)} on ${day(before[0].at, { day: "numeric", month: "short" })}${before[0].category ? ` (${esc(before[0].category)})` : ""}`
      : `First ${verb} ${t.direction === "debit" ? "to" : "from"} them`);
  }
  if (t.direction === "debit") {
    const start = new Date(`${istDay(t.at)}T00:00:00+05:30`);
    const sameDay = await db.select().from(txns).where(and(gte(txns.at, start), lt(txns.at, new Date(start.getTime() + 86_400_000))));
    lines.push(`Spent that day: ${rupees(summarize(sameDay).spent)}`);
  }
  const keyboard: Keyboard = [];
  if (!t.category) {
    lines.push("What was this?");
    const cats = t.direction === "debit" ? [...SPEND, ...DEBIT_OTHER] : CREDIT;
    keyboard.push(...rows(cats.map((c) => ({ text: c, callback_data: `c|${t.id}|${c}` })), 3));
    if (t.tag) lines.push(`🏷 ${esc(t.tag)}`);
  } else lines.push(`✓ ${t.category}${t.tag ? ` · ${esc(t.tag)}` : ""}${WHY[t.source ?? ""] ?? ""}`);

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
  // "Change label" (null) also drops the sub-label, here and in the payee memory; picking a category keeps it.
  const [t] = await db.update(txns).set({ category, source: category ? "user" : null, ...(category ? {} : { tag: null }) }).where(eq(txns.id, id)).returning();
  if (!t) return;
  if (category && t.payeeKey !== "unknown")
    await db.insert(payees).values({ key: t.payeeKey, category }).onConflictDoUpdate({ target: payees.key, set: { category } });
  if (!category) await db.update(payees).set({ tag: null }).where(eq(payees.key, t.payeeKey));
  if (t.tgMessageId) await show(t);
}

async function splitEqually(t: Txn, target: string) {
  const plan = await equalPlan(target, t.amount);
  if (!plan) return show(t, { note: "⚠️ That group or person no longer exists." });
  const done = await postSplit(t, plan, target);
  if (done) await show(done);
}

/** Stores a sub-label on the payment and remembers it for the payee. */
async function setTag(t: Txn, tag: string): Promise<Txn> {
  const db = getDb();
  const [done] = await db.update(txns).set({ tag }).where(eq(txns.id, t.id)).returning();
  if (t.payeeKey !== "unknown")
    await db.insert(payees).values({ key: t.payeeKey, tag }).onConflictDoUpdate({ target: payees.key, set: { tag } });
  return done;
}

const REPLY_HINT = "Reply to a payment with a sub-label such as <code>Wi-Fi</code> or <code>Bills: Wi-Fi</code>, or with shares to split it unevenly: <code>me 300, Aman 500</code>";

/**
 * A typed reply to a payment card: a name for a settle-up, shares such as "me 300, Aman 500",
 * or a label: "Wi-Fi" (sub-label), "Bills: Wi-Fi" (category and sub-label) or "Bills" (category).
 */
async function handleReply(t: Txn, text: string) {
  if (t.category === "Settle-up") {
    const done = await settle(t, await findOrCreatePerson(text));
    return done ? show(done) : undefined;
  }
  const parts = parseShares(text);
  if (!parts) {
    const clean = text.trim().replace(/\s+/g, " ");
    if (/\d/.test(clean) || clean.length > 40) return tgSend(REPLY_HINT); // digits mean a mistyped split, not a label
    const m = /^([^:/]+?) ?[:/] ?(.+)$/.exec(clean);
    const category = ALL.find((c) => c.toLowerCase() === (m ? m[1] : clean).toLowerCase());
    if (category && !m) return setCategory(t.id, category);
    const tagged = await setTag(t, m && category ? m[2] : clean);
    return m && category ? setCategory(t.id, category) : show(tagged);
  }
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

/** A payment the bank never sees, typed as "spent 200 chai". Labelled from memory or a confident guess, else asked. */
async function addCash(amount: number, note: string) {
  const db = getDb();
  const at = new Date();
  const payeeKey = note ? payeeKeyOf(note) || "unknown" : "unknown";
  const known = payeeKey === "unknown" ? undefined : (await db.select().from(payees).where(eq(payees.key, payeeKey)))[0];
  let category = known?.category ?? null, source = category ? "memory" : null;
  if (!category && note) {
    const g = await guessCategory({ payee: note, amount, direction: "debit", at });
    if (g && g.confidence >= AI_SILENT_AT) [category, source] = [g.category, "ai"];
  }
  const [t] = await db.insert(txns)
    .values({ at, amount, direction: "debit", account: "Cash", payee: note || "Cash", payeeKey, category, source, tag: source === "memory" ? known?.tag ?? null : null })
    .returning();
  await show(t);
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
  "I message you about every payment. Tap a button to label or split it, or reply to a payment with shares like <code>me 300, Aman 500</code>.",
  "Reply to a payment with <code>Wi-Fi</code> to add a sub-label, or <code>Bills: Wi-Fi</code> to set both. Totals stay under the category.",
  "",
  "<code>/who</code> — who owes whom",
  "<code>/group Flat: Aman, Riya</code> — make a group for one-tap splits",
  "<code>Aman owes 500 dinner</code> — add what someone owes you",
  "<code>owe Aman 500 cab</code> — add what you owe someone",
  "<code>spent 200 chai</code> — add a cash payment",
  "<code>/merge Ratna into Ratnashree</code> — one friend saved under two names",
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
  else if (cmd?.kind === "cash") await addCash(cmd.amount, cmd.note);
  else if (cmd?.kind === "merge") {
    const kept = await mergePeople(cmd.from, cmd.to);
    await tgSend(kept ? `Merged. ${esc(cmd.from)}'s history now belongs to ${esc(kept.name)}.` : `I need two different names that are both in your ledger. <code>/who</code> lists them.`);
  } else if (cmd?.kind === "due") {
    const p = await addDue(cmd.person, cmd.amount, cmd.note);
    const net = (await balances()).find((b) => b.id === p.id)?.amount ?? 0;
    await tgSend(`Noted. ${net === 0 ? `You and ${esc(p.name)} are settled up.` : net > 0 ? `${esc(p.name)} now owes you ${rupees(net)}.` : `You now owe ${esc(p.name)} ${rupees(-net)}.`}`);
  } else await tgSend(HELP);
}
