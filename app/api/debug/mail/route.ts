import { desc } from "drizzle-orm";
import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/auth";
import { getDb, schema } from "@/db";
import { parseEmail } from "@/lib/parse";

export const dynamic = "force-dynamic";

/** Parser check: the latest stored mails and SMS, each with what the current parser makes of it. Same secret as ingest. */
export async function GET(req: Request) {
  if (!isCronAuthorized(req.headers)) return new NextResponse("forbidden", { status: 403 });
  const rows = await getDb().select().from(schema.emails).orderBy(desc(schema.emails.receivedAt)).limit(60);
  return NextResponse.json(rows.map((r) => ({
    id: r.id.slice(0, 8), at: r.receivedAt, sender: r.sender, subject: r.subject, storedKind: r.kind,
    now: parseEmail({ from: r.sender, subject: r.subject, text: r.body }),
    body: r.body.replace(/\s+/g, " ").slice(0, 700),
  })));
}
