// Single-user auth: a shared secret for machine callers and a password + signed cookie for the dashboard.
import { env } from "./env";
import { hmacHex, safeEqual } from "./crypto";

export const SESSION_COOKIE = "paisa_session";
const SESSION_DAYS = 30;

/** Apps Script sends `X-Cron-Secret`; Vercel cron sends `Authorization: Bearer`. */
export function isCronAuthorized(headers: Headers): boolean {
  const secret = env("CRON_SECRET");
  if (!secret) return false;
  const bearer = headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return safeEqual(headers.get("x-cron-secret"), secret) || safeEqual(bearer, secret);
}

export function checkPassword(candidate: string): boolean {
  const pw = env("DASHBOARD_PASSWORD");
  return !!pw && safeEqual(candidate, pw);
}

/** Cookie value "<expiresEpochSeconds>.<hmac>". Stateless; rotating SESSION_SECRET signs everyone out. */
export function makeSession(now = new Date()): { value: string; expires: Date } {
  const secret = env("SESSION_SECRET");
  if (!secret) throw new Error("SESSION_SECRET is not set");
  const expires = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
  const exp = String(Math.floor(expires.getTime() / 1000));
  return { value: `${exp}.${hmacHex(secret, `session:${exp}`)}`, expires };
}

export function isValidSession(value: string | undefined, now = new Date()): boolean {
  const secret = env("SESSION_SECRET");
  if (!secret || !value) return false;
  const [exp, sig] = value.split(".");
  if (!exp || !sig || !/^\d+$/.test(exp)) return false;
  if (Number(exp) * 1000 < now.getTime()) return false;
  return safeEqual(sig, hmacHex(secret, `session:${exp}`));
}
