// Thin clients for the two outside services: Telegram and Groq.
import { requireEnv, env } from "./env";
import { ALL, type SplitPart } from "./money";

// ---------- Telegram (the bot only ever talks to TG_CHAT_ID) ----------
export type Keyboard = { text: string; callback_data: string }[][];

export async function tg(method: string, body: Record<string, unknown>): Promise<{ message_id?: number; file_path?: string } | undefined> {
  const res = await fetch(`https://api.telegram.org/bot${requireEnv("TG_BOT_TOKEN")}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; result?: { message_id?: number; file_path?: string }; description?: string };
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

/** A voice note as text (Telegram only sends the audio). `hint` lists names so Whisper spells them right. Null on any failure. */
export async function transcribeVoice(fileId: string, hint: string): Promise<string | null> {
  const key = env("GROQ_API_KEY");
  if (!key) return null;
  try {
    const path = (await tg("getFile", { file_id: fileId }))?.file_path;
    const audio = path ? await fetch(`https://api.telegram.org/file/bot${requireEnv("TG_BOT_TOKEN")}/${path}`) : null;
    if (!audio?.ok) return null;
    const form = new FormData();
    form.set("file", new File([await audio.arrayBuffer()], "voice.ogg", { type: "audio/ogg" }));
    form.set("model", env("GROQ_STT_MODEL") ?? "whisper-large-v3-turbo");
    form.set("temperature", "0");
    form.set("prompt", hint);
    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(30_000),
    });
    return res.ok ? ((await res.json()) as { text?: string }).text?.trim() || null : null;
  } catch {
    return null;
  }
}

/** Free-form split ("me 1/3 Sarthak 2/3", "equally with Aman and Riya") as parts; the code does the arithmetic. Null = not a split or no answer. */
export async function parseSplit(text: string, known: { people: string[]; groups: string[] }): Promise<SplitPart[] | null> {
  const out = (await groqJson(
    `You read a typed or spoken instruction for splitting ONE shared payment. Reply with JSON {"split": boolean, "parts": [{"name": string, "amount"?: number, "share"?: string}]}. ` +
    `split is false when the text is not about splitting (for example a label like "Wi-Fi"). One part per person; "me" is the speaker. "amount" is rupees exactly as said. "share" is the person's part of the whole as said: "1/3", "2/3", "20%". ` +
    `Give neither when the person just shares equally. "equally with everyone/all" is a part named "all". Never calculate. Known people: ${JSON.stringify(known.people)}. Known groups: ${JSON.stringify(known.groups)}. If a name sounds like a known one, use the known spelling.`,
    text, 400)) as { split?: unknown; parts?: unknown } | null;
  const parts = out?.split === true && Array.isArray(out.parts) ? (out.parts as SplitPart[]) : null;
  return parts?.length && parts.every((p) => p && typeof p.name === "string") ? parts : null;
}

const LABEL_RULES = `Categories: ${JSON.stringify(ALL)}. A known brand or merchant earns high confidence. A payment to a private person's name or UPI id is a guess: keep confidence below 0.5.`;
type Guess = { category: string; confidence: number; tag?: string };
const validGuess = (g: unknown): g is Guess =>
  !!g && typeof (g as Guess).confidence === "number" && ALL.includes((g as Guess).category);

/** Category guess from payee, amount and time only: no account numbers leave the app. Null = no usable answer. */
export async function guessCategory(t: { payee: string; amount: number; direction: string; at: Date }, tags: string[] = []): Promise<Guess | null> {
  const time = t.at.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", hour: "numeric", minute: "2-digit" });
  const out = await groqJson(
    `You label one bank transaction of a salaried person in India. Reply with JSON {"category": string, "confidence": 0 to 1${tags.length ? ', "tag": string (optional)' : ""}}. ${LABEL_RULES}${tags.length ? ` The person's own labels: ${JSON.stringify(tags)}. Add "tag" with one of them, copied exactly, only if it clearly fits this payment; otherwise leave it out.` : ""}`,
    `${t.direction} of Rs ${t.amount / 100} ${t.direction === "debit" ? "to" : "from"} "${t.payee}" on ${time}`, 300);
  if (!validGuess(out)) return null;
  const tag = tags.find((x) => x.toLowerCase() === String(out.tag ?? "").trim().toLowerCase()); // only labels you already use
  return { category: out.category, confidence: out.confidence, tag };
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
