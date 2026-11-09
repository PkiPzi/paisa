// Thin clients for the three outside services: Telegram, Splitwise and Groq.
import { requireEnv, env } from "./env";
import { ALL } from "./money";

// ---------- Telegram (the bot only ever talks to TG_CHAT_ID) ----------
export type Keyboard = { text: string; callback_data: string }[][];

export async function tg(method: string, body: Record<string, unknown>): Promise<{ message_id?: number } | undefined> {
  const res = await fetch(`https://api.telegram.org/bot${requireEnv("TG_BOT_TOKEN")}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; result?: { message_id?: number }; description?: string };
  // Editing a message to identical content is an error in Telegram's eyes, not ours.
  if (!json.ok && !/not modified/i.test(json.description ?? "")) throw new Error(`telegram ${method}: ${json.description ?? res.status}`);
  return typeof json.result === "object" ? json.result : undefined;
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function tgSend(html: string, keyboard?: Keyboard): Promise<number | undefined> {
  const r = await tg("sendMessage", {
    chat_id: requireEnv("TG_CHAT_ID"), text: html, parse_mode: "HTML",
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
  return r?.message_id;
}

export function tgEdit(messageId: number, html: string, keyboard: Keyboard = []) {
  return tg("editMessageText", {
    chat_id: requireEnv("TG_CHAT_ID"), message_id: messageId, text: html, parse_mode: "HTML",
    reply_markup: { inline_keyboard: keyboard },
  });
}

// ---------- Splitwise ----------
async function sw<T>(path: string, form?: Record<string, string>): Promise<T> {
  const res = await fetch(`https://secure.splitwise.com/api/v3.0/${path}`, {
    method: form ? "POST" : "GET",
    headers: { Authorization: `Bearer ${requireEnv("SPLITWISE_API_KEY")}`, ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: form ? new URLSearchParams(form) : undefined,
  });
  if (!res.ok) throw new Error(`splitwise ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

type SwUser = { id: number; first_name: string | null; last_name: string | null };
type SwBalance = { currency_code: string; amount: string };
export type SwFriend = SwUser & { balance: SwBalance[]; updated_at: string };
export type SwGroup = { id: number; name: string; updated_at: string; members: SwUser[] };

export const swName = (u: SwUser) => u.first_name ?? "Friend";
export const swMe = async () => (await sw<{ user: SwUser }>("get_current_user")).user;
export const swFriends = async () => (await sw<{ friends: SwFriend[] }>("get_friends")).friends;
/** Real groups only; id 0 is Splitwise's "non-group expenses" bucket. */
export const swGroups = async () => (await sw<{ groups: SwGroup[] }>("get_groups")).groups.filter((g) => g.id !== 0);

/** Net INR balance per friend in paise: positive = they owe you. */
export async function swBalances(): Promise<{ name: string; amount: number }[]> {
  return (await swFriends())
    .map((f) => ({ name: swName(f), amount: Math.round(Number(f.balance.find((b) => b.currency_code === "INR")?.amount ?? 0) * 100) }))
    .filter((b) => b.amount !== 0)
    .sort((a, b) => b.amount - a.amount);
}

/** You paid the whole cost; `owed` is each person's share in paise, with you included. Returns the expense id. */
export async function swCreateExpense(e: { cost: number; description: string; date: Date; groupId: number; meId: number; owed: { userId: number; amount: number }[] }): Promise<string> {
  const form: Record<string, string> = {
    cost: (e.cost / 100).toFixed(2), description: e.description, date: e.date.toISOString(),
    currency_code: "INR", group_id: String(e.groupId),
  };
  e.owed.forEach((o, i) => {
    form[`users__${i}__user_id`] = String(o.userId);
    form[`users__${i}__paid_share`] = (o.userId === e.meId ? e.cost / 100 : 0).toFixed(2);
    form[`users__${i}__owed_share`] = (o.amount / 100).toFixed(2);
  });
  const r = await sw<{ expenses?: { id: number }[]; errors?: Record<string, unknown> }>("create_expense", form);
  const id = r.expenses?.[0]?.id;
  if (!id) throw new Error(`splitwise refused the expense: ${JSON.stringify(r.errors ?? {}).slice(0, 200)}`);
  return String(id);
}

// ---------- Groq (free tier) ----------
/** One JSON-mode call. Null on any failure: callers fall back to asking the user. */
async function groqJson(system: string, user: string, maxTokens: number): Promise<unknown> {
  const key = env("GROQ_API_KEY");
  if (!key) return null;
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env("GROQ_MODEL") ?? "openai/gpt-oss-20b",
        reasoning_effort: "low",
        temperature: 0,
        max_completion_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return JSON.parse(json.choices?.[0]?.message?.content ?? "null");
  } catch {
    return null;
  }
}

const LABEL_RULES = `Categories: ${JSON.stringify(ALL)}. A known brand or merchant earns high confidence. A payment to a private person's name or UPI id is a guess: keep confidence below 0.5.`;
type Guess = { category: string; confidence: number };
const validGuess = (g: unknown): g is Guess =>
  !!g && typeof (g as Guess).confidence === "number" && ALL.includes((g as Guess).category);

/** Category guess from payee, amount and time only: no account numbers leave the app. Null = no usable answer. */
export async function guessCategory(t: { payee: string; amount: number; direction: string; at: Date }): Promise<Guess | null> {
  const time = t.at.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", hour: "numeric", minute: "2-digit" });
  const out = await groqJson(
    `You label one bank transaction of a salaried person in India. Reply with JSON {"category": string, "confidence": 0 to 1}. ${LABEL_RULES}`,
    `${t.direction} of Rs ${t.amount / 100} ${t.direction === "debit" ? "to" : "from"} "${t.payee}" on ${time}`, 300);
  return validGuess(out) ? out : null;
}

/** Statement import: many payees in one call. The result has the same length as the input; null where unsure. */
export async function guessCategories(items: { payee: string; amount: number; direction: string }[]): Promise<(Guess | null)[]> {
  const out = (await groqJson(
    `You label bank transactions of a salaried person in India. Reply with JSON {"labels": [{"category": string, "confidence": 0 to 1}, ...]}, one entry per input line, in order. ${LABEL_RULES}`,
    items.map((t, i) => `${i + 1}. ${t.direction} of Rs ${t.amount / 100} ${t.direction === "debit" ? "to" : "from"} "${t.payee}"`).join("\n"),
    60 * items.length + 200)) as { labels?: unknown[] } | null;
  return items.map((_, i) => (out?.labels?.length === items.length && validGuess(out.labels[i]) ? (out.labels[i] as Guess) : null));
}
