// Thin clients for the two outside services: Telegram and Groq.
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

/** Monthly review text written from the given facts only. Null when Groq is unavailable: the numbers are still sent. */
export async function writeReview(facts: unknown): Promise<string | null> {
  const out = (await groqJson(
    `You write a short monthly money review for a salaried, hands-off investor in India who buys index and mutual funds through SIPs and does not trade. Use ONLY the facts in the JSON you are given. Never predict prices, never name a security to buy that is not in the facts, never suggest timing the market. Say what went well, what to watch, and at most two concrete, low-effort actions; if nothing needs doing, say so. Plain words, under 150 words. Reply with JSON {"review": string}.`,
    JSON.stringify(facts), 700)) as { review?: unknown } | null;
  return typeof out?.review === "string" && out.review.trim() ? out.review.trim() : null;
}
