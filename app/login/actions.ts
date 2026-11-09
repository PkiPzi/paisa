"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { checkPassword, makeSession, SESSION_COOKIE } from "@/lib/auth";

export async function login(form: FormData) {
  if (!checkPassword(String(form.get("password") ?? ""))) {
    await new Promise((r) => setTimeout(r, 1500)); // slow down guessing
    redirect("/login?e=1");
  }
  const { value, expires } = makeSession();
  (await cookies()).set(SESSION_COOKIE, value, { httpOnly: true, secure: true, sameSite: "lax", path: "/", expires });
  redirect("/");
}

export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
