import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/auth";
import { ingestEmail } from "@/lib/bot";
import { bankOf, isOtp } from "@/lib/parse";

export const dynamic = "force-dynamic";

/**
 * The phone's SMS forwarder posts `{"from":"%from%","text":"%text%","sentStamp":%sentStamp%}`.
 * Anything that is not from a bank, and every one-time password, is dropped here without being stored,
 * whatever the filter on the phone lets through.
 */
export async function POST(req: Request) {
  if (!isCronAuthorized(req.headers)) return new NextResponse("forbidden", { status: 403 });
  const m = (await req.json().catch(() => null)) as { from?: unknown; text?: unknown; sentStamp?: unknown } | null;
  if (!m || typeof m.from !== "string" || typeof m.text !== "string") return NextResponse.json({ error: "bad payload" }, { status: 400 });
  if (!bankOf(m.from) || isOtp(m.text)) return NextResponse.json({ result: "skipped" });

  const sent = Number(m.sentStamp);
  const date = new Date(sent > 0 ? sent : Date.now());
  // The same message always gets the same id, so the forwarder's retries are not stored twice.
  const id = "sms:" + createHash("sha256").update(`${m.from}|${m.sentStamp}|${m.text}`).digest("hex").slice(0, 24);
  const result = await ingestEmail({ id, from: m.from, subject: "", date: date.toISOString(), text: m.text });
  return NextResponse.json({ result });
}
