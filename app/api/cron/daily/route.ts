import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/auth";
import { runDaily } from "@/lib/daily";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // AMFI download plus one quote per stock

export async function GET(req: Request) {
  if (!isCronAuthorized(req.headers)) return new NextResponse("forbidden", { status: 403 });
  return NextResponse.json({ sent: await runDaily() });
}
