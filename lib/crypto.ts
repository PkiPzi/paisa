import { createHmac, createHash, timingSafeEqual } from "node:crypto";

export function hmacHex(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

/** Constant-time string compare (hashes first so lengths never leak). */
export function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}
