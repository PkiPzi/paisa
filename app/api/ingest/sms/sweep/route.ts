import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/auth";
import { ingestSms, smsTime } from "@/lib/sms";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const BUDGET_MS = 40_000; // each new payment costs a Groq call and a Telegram message; the next sweep takes the rest

/**
 * The safety net: the phone posts its recent inbox (phone/paisa-sweep.sh) and anything the live forwarder
 * missed is stored now, oldest first. Messages already stored are skipped, so sweeping often is harmless.
 * `?days=N` looks further back (default 3, at most 31).
 */
export async function POST(req: Request) {
  if (!isCronAuthorized(req.headers)) return new NextResponse("forbidden", { status: 403 });
  const list = (await req.json().catch(() => null)) as Record<string, unknown>[] | null;
  if (!Array.isArray(list)) return NextResponse.json({ error: "expected a list of messages" }, { status: 400 });
  const days = Math.min(31, Math.max(1, Number(new URL(req.url).searchParams.get("days")) || 3));
  const since = Date.now() - days * 86_400_000;

  const msgs = list.flatMap((m) => {
    const from = [m.number, m.address, m.sender, m.from].find((x) => typeof x === "string" && x) as string | undefined;
    const text = [m.body, m.text].find((x) => typeof x === "string" && x) as string | undefined;
    const at = smsTime(m.received ?? m.sentStamp ?? m.date) ?? new Date();
    return from && text && at.getTime() >= since ? [{ from, text, at }] : [];
  }).sort((a, b) => a.at.getTime() - b.at.getTime());

  const count: Record<string, number> = { added: 0, duplicate: 0, skipped: 0, left: 0 };
  const started = Date.now();
  for (const m of msgs) {
    if (Date.now() - started > BUDGET_MS) { count.left++; continue; }
    const r = await ingestSms(m.from, m.text, m.at);
    count[r === "duplicate" || r === "skipped" ? r : "added"]++;
  }
  return NextResponse.json(count);
}
