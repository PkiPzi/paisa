import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/auth";
import { ingestSms, smsTime } from "@/lib/sms";

export const dynamic = "force-dynamic";

/** The phone's SMS forwarder posts `{"from":"%from%","text":"%text%","sentStamp":%sentStamp%}` as each SMS arrives. */
export async function POST(req: Request) {
  if (!isCronAuthorized(req.headers)) return new NextResponse("forbidden", { status: 403 });
  const m = (await req.json().catch(() => null)) as { from?: unknown; text?: unknown; sentStamp?: unknown } | null;
  if (!m || typeof m.from !== "string" || typeof m.text !== "string") return NextResponse.json({ error: "bad payload" }, { status: 400 });
  const result = await ingestSms(m.from, m.text, smsTime(m.sentStamp) ?? new Date());
  if (result === "skipped") console.log(`sms skipped from ${m.from}`); // never the text
  return NextResponse.json({ result });
}
