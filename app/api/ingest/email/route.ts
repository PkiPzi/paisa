import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/auth";
import { ingestEmail, type Mail } from "@/lib/bot";
import { knownMailSender } from "@/lib/parse";

export const dynamic = "force-dynamic";

/** Apps Script posts one bank or merchant mail at a time. */
export async function POST(req: Request) {
  if (!isCronAuthorized(req.headers)) return new NextResponse("forbidden", { status: 403 });
  const m = (await req.json().catch(() => null)) as Partial<Mail> | null;
  if (!m || typeof m.id !== "string" || typeof m.from !== "string" || typeof m.text !== "string" || Number.isNaN(Date.parse(m.date ?? "")))
    return NextResponse.json({ error: "bad payload" }, { status: 400 });
  if (!knownMailSender(m.from)) return NextResponse.json({ result: "skipped" }); // personal mail is never stored
  const result = await ingestEmail({ id: m.id, from: m.from, subject: m.subject ?? "", date: m.date!, text: m.text });
  return NextResponse.json({ result });
}
