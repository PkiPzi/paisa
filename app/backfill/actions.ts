"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { isValidSession, SESSION_COOKIE } from "@/lib/auth";
import { equalPlan, loadSplitwise, postSplit } from "@/lib/bot";
import { MAX_BATCH } from "./limits";


export async function postBackfill(form: FormData) {
  if (!isValidSession((await cookies()).get(SESSION_COOKIE)?.value)) throw new Error("not signed in");
  const target = String(form.get("target") ?? "");
  const ids = form.getAll("pick").map(Number).filter(Number.isInteger).slice(0, MAX_BATCH);
  if (!/^[gf]:\d+$/.test(target) || !ids.length) redirect("/backfill");

  const [sw, picked] = await Promise.all([loadSplitwise(), getDb().select().from(schema.txns).where(inArray(schema.txns.id, ids))]);
  let done = 0, failed = 0;
  // One at a time: Splitwise rate-limits bursts, and postSplit refuses a payment that is already split.
  for (const t of picked) {
    const plan = equalPlan(sw, target, t.amount);
    const r = plan ? await postSplit(t, sw.me.id, plan, target) : "target missing";
    if (typeof r === "string") { if (r) failed++; } else done++;
  }
  redirect(`/backfill?done=${done}&failed=${failed}`);
}
