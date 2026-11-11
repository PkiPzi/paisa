"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { isValidSession, SESSION_COOKIE } from "@/lib/auth";
import { equalPlan, postSplit } from "@/lib/ledger";
import { MAX_BATCH } from "./limits";

export async function postBackfill(form: FormData) {
  if (!isValidSession((await cookies()).get(SESSION_COOKIE)?.value)) throw new Error("not signed in");
  const target = String(form.get("target") ?? "");
  const ids = form.getAll("pick").map(Number).filter(Number.isInteger).slice(0, MAX_BATCH);
  if (!/^[gp]:\d+$/.test(target) || !ids.length) redirect("/backfill");

  const picked = await getDb().select().from(schema.txns).where(inArray(schema.txns.id, ids));
  let done = 0;
  for (const t of picked) {
    const plan = await equalPlan(target, t.amount);
    if (plan && (await postSplit(t, plan, target))) done++;
  }
  redirect(`/backfill?done=${done}`);
}
