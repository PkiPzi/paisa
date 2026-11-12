import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/auth";
import { getDb, schema } from "@/db";
import { ingestEmail, show } from "@/lib/bot";
import { knownMailSender, parseEmail } from "@/lib/parse";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const { emails, txns } = schema;

/** Parser check: the latest stored mails and SMS, each with what the current parser makes of it. Same secret as ingest. */
export async function GET(req: Request) {
  if (!isCronAuthorized(req.headers)) return new NextResponse("forbidden", { status: 403 });
  const rows = await getDb().select().from(emails).orderBy(desc(emails.receivedAt)).limit(80);
  return NextResponse.json(rows.map((r) => ({
    id: r.id.slice(0, 8), at: r.receivedAt, sender: r.sender, subject: r.subject, storedKind: r.kind,
    now: parseEmail({ from: r.sender, subject: r.subject, text: r.body }),
    body: r.body.replace(/\s+/g, " ").slice(0, 700),
  })));
}

/**
 * After a parser fix: re-reads everything stored. Mail from unknown senders is deleted, a payment whose
 * payee or account now reads differently is corrected and its card redrawn, and a message that was
 * ignored but now parses is ingested properly. Labels you set are kept.
 */
export async function POST(req: Request) {
  if (!isCronAuthorized(req.headers)) return new NextResponse("forbidden", { status: 403 });
  const db = getDb();
  const started = Date.now();
  const count = { removed: 0, corrected: 0, ingested: 0, left: 0 };
  for (const r of await db.select().from(emails).orderBy(emails.receivedAt)) {
    if (Date.now() - started > 40_000) { count.left++; continue; }
    const sms = r.id.startsWith("sms:");
    if (!sms && !knownMailSender(r.sender)) {
      if (r.kind === "ignored") { await db.delete(emails).where(eq(emails.id, r.id)); count.removed++; }
      continue;
    }
    const p = parseEmail({ from: r.sender, subject: r.subject, text: r.body });
    if (r.kind === "ignored" && p.kind !== "ignored") {
      await db.delete(emails).where(eq(emails.id, r.id));
      await ingestEmail({ id: r.id, from: r.sender, subject: r.subject, date: r.receivedAt.toISOString(), text: r.body });
      count.ingested++;
    } else if (r.kind === "txn" && p.kind === "txn") {
      const [t] = await db.select().from(txns).where(eq(txns.emailId, r.id));
      const suffix = / \([^)]+\)$/.exec(t?.payee ?? "")?.[0] ?? ""; // " (Zepto)" added by a matching receipt
      if (t && (t.payee !== p.payee + suffix || t.account !== p.account)) {
        const [fixed] = await db.update(txns).set({ payee: p.payee + suffix, payeeKey: p.payeeKey, account: p.account }).where(eq(txns.id, t.id)).returning();
        if (fixed.tgMessageId) await show(fixed);
        count.corrected++;
      }
    }
  }
  return NextResponse.json(count);
}
