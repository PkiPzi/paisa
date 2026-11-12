// Bank SMS from the phone: the live forwarder sends one at a time, the sweeper re-sends the recent inbox.
import { createHash } from "node:crypto";
import { and, gte, like } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ingestEmail } from "./bot";
import { bankOf, isOtp } from "./parse";

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** "2026-11-12 14:03:11" (phone local time, IST), epoch milliseconds, or anything Date understands. Null if none. */
export function smsTime(v: unknown): Date | null {
  const d = typeof v === "number" || /^\d{11,}$/.test(String(v)) ? new Date(Number(v))
    : typeof v === "string" && /^\d{4}-\d\d-\d\d \d\d:\d\d(:\d\d)?$/.test(v) ? new Date(v.replace(" ", "T") + "+05:30")
    : new Date(String(v ?? ""));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Stores one bank SMS. Anything not from a bank, and every one-time password, is dropped without being stored.
 * The id comes from the text alone, so the same message sent by the forwarder and again by the sweeper is one row.
 */
export async function ingestSms(from: string, text: string, at: Date): Promise<string> {
  if (!bankOf(from) || isOtp(text)) return "skipped";
  const { emails } = schema;
  // Also compare stored text, for messages saved under an older id scheme.
  const recent = await getDb().select({ body: emails.body }).from(emails)
    .where(and(like(emails.id, "sms:%"), gte(emails.receivedAt, new Date(at.getTime() - 3 * 86_400_000))));
  if (recent.some((r) => squash(r.body) === squash(text))) return "duplicate";
  const id = "sms:" + createHash("sha256").update(squash(text)).digest("hex").slice(0, 24);
  return ingestEmail({ id, from, subject: "", date: at.toISOString(), text });
}
