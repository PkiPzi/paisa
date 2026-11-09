"use server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { isValidSession, SESSION_COOKIE } from "@/lib/auth";
import { ALL } from "@/lib/money";
import { setCategory } from "@/lib/bot";

export async function relabel(id: number, category: string) {
  // Server actions are public endpoints, so the session is checked here and not only by the page guard.
  if (!isValidSession((await cookies()).get(SESSION_COOKIE)?.value)) throw new Error("not signed in");
  if (!Number.isInteger(id) || (category !== "" && !ALL.includes(category))) throw new Error("bad input");
  await setCategory(id, category || null);
  revalidatePath("/");
}
