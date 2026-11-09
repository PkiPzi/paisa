import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { safeEqual } from "@/lib/crypto";
import { handleUpdate } from "@/lib/bot";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const secret = env("TG_WEBHOOK_SECRET");
  const chat = env("TG_CHAT_ID");
  if (!secret || !chat || !safeEqual(req.headers.get("x-telegram-bot-api-secret-token"), secret)) return new NextResponse("forbidden", { status: 403 });
  try {
    await handleUpdate(await req.json(), chat);
  } catch (e) {
    console.error("telegram update failed", e); // still 200: Telegram would otherwise resend the same update for hours
  }
  return new NextResponse(null, { status: 200 });
}
