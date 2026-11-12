import { beforeAll, expect, it, vi } from "vitest";

// Embedded Postgres in memory; Telegram is stubbed and Groq has no key, so nothing leaves the machine.
process.env.PGLITE_DIR = "memory://";
process.env.TG_BOT_TOKEN = "t";
process.env.TG_CHAT_ID = "1";
const sent: { method: string; body: { text?: string } }[] = [];
vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
  sent.push({ method: url.split("/").pop()!, body: JSON.parse(init.body) });
  return new Response(JSON.stringify({ ok: true, result: { message_id: 100 + sent.length } }));
});

const { getDb, schema } = await import("@/db");
const { ingestEmail, setCategory, handleUpdate } = await import("@/lib/bot");
const upi = (id: string, date: string, rupees = "87.00", vpa = "ramesh.k@okaxis") => ({
  id, from: "alerts@icicibank.com", subject: "Transaction alert", date,
  text: `Your ICICI Bank Account XX1234 has been debited for Rs ${rupees} and account ${vpa} has been credited.`,
});

beforeAll(async () => {
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  await migrate(getDb() as never, { migrationsFolder: "./drizzle" });
});

it("asks once, remembers the payee, and lets a receipt label a debit", async () => {
  const db = getDb();
  expect(await ingestEmail(upi("m1", "2026-11-10T10:00:00Z"))).toBe("txn");
  expect(await ingestEmail(upi("m1", "2026-11-10T10:00:00Z"))).toBe("duplicate");
  expect(sent).toHaveLength(1); // one question, not two
  expect(sent[0].body.text).toContain("What was this?");

  const [first] = await db.select().from(schema.txns);
  await setCategory(first.id, "Ride"); // what tapping the button does
  expect(sent.at(-1)!.method).toBe("editMessageText");

  const before = sent.length;
  await ingestEmail(upi("m2", "2026-11-11T10:00:00Z")); // same payee again: labelled from memory, and you are told
  expect(sent).toHaveLength(before + 1);
  expect(sent.at(-1)!.body.text).toContain("✓ Ride (same as last time)");

  // An unknown payee, then a Rapido receipt for the same amount 10 minutes later.
  await ingestEmail(upi("m3", "2026-11-12T10:00:00Z", "142.00", "driver9@ybl"));
  await ingestEmail({ id: "m4", from: "noreply@rapido.bike", subject: "Ride receipt", date: "2026-11-12T10:10:00Z", text: "Total ₹142" });

  const all = await db.select().from(schema.txns).orderBy(schema.txns.id);
  expect(all.map((t) => [t.category, t.source])).toEqual([["Ride", "user"], ["Ride", "memory"], ["Ride", "receipt"]]);
  expect(all[2].payee).toBe("driver9@ybl (Rapido)");
});

it("stores one payment when the bank sends both an SMS and a mail", async () => {
  const db = getDb();
  const count = async () => (await db.select().from(schema.txns)).length;
  const before = await count();
  const sms = { id: "sms:abc", from: "AD-ICICIT-S", subject: "", date: "2026-12-01T10:00:00Z", text: "ICICI Bank Acct XX1234 debited for Rs 311.00 on 01-Dec-26; SOME SHOP credited. UPI:1." };
  expect(await ingestEmail(sms)).toBe("txn");
  expect(await ingestEmail(upi("m-twin", "2026-12-01T10:03:00Z", "311.00", "someshop@ybl"))).toBe("duplicate");
  // Two real payments of the same amount on one channel are both kept.
  expect(await ingestEmail({ ...sms, id: "sms:def", date: "2026-12-01T10:05:00Z" })).toBe("txn");
  expect(await count()).toBe(before + 2);
});

it("takes a typed sub-label, keeps the category for totals, and reuses both for the payee", async () => {
  const db = getDb();
  await ingestEmail(upi("w1", "2026-12-05T10:00:00Z", "799.00", "fibernet@icici"));
  const [first] = (await db.select().from(schema.txns).orderBy(schema.txns.id)).slice(-1);
  await handleUpdate({ message: { chat: { id: 1 }, text: "bills: Wi-Fi", reply_to_message: { message_id: first.tgMessageId! } } }, "1");
  await ingestEmail(upi("w2", "2026-12-06T10:00:00Z", "799.00", "fibernet@icici"));
  const last = (await db.select().from(schema.txns).orderBy(schema.txns.id)).slice(-2);
  expect(last.map((t) => [t.category, t.tag])).toEqual([["Bills", "Wi-Fi"], ["Bills", "Wi-Fi"]]);
  expect(sent.at(-1)!.body.text).toContain("✓ Bills · Wi-Fi (same as last time)");
});

it("sweeping the inbox adds only what the live forwarder missed", async () => {
  const { ingestSms, smsTime } = await import("@/lib/sms");
  const text = (ref: string) => `ICICI Bank Acct XX1234 debited for Rs 64.00 on 20-Dec-26; TEA STALL credited. UPI:${ref}. Call 18002662 for dispute.`;
  const at = smsTime("2026-12-20 09:30:00")!;
  expect(at.toISOString()).toBe("2026-12-20T04:00:00.000Z"); // phone time is IST
  expect(await ingestSms("AX-ICICIT-S", text("111111111111"), at)).toBe("txn"); // live
  expect(await ingestSms("AX-ICICIT-S", text("111111111111"), at)).toBe("duplicate"); // swept later
  expect(await ingestSms("AX-ICICIT-S", text("222222222222"), new Date(at.getTime() + 60_000))).toBe("txn"); // missed live, same amount: kept
  expect(await ingestSms("AX-ICICIT-S", "482913 is your OTP for txn of Rs 64.00", at)).toBe("skipped");
  expect(await ingestSms("JM-JIOPAY", "Rs 64 debited", at)).toBe("skipped");
  expect(sent.at(-1)!.body.text).toContain("ref 222222222222");
  expect(sent.at(-1)!.body.text).toContain("1 earlier payment");
});

it("records a typed cash payment and shows its card", async () => {
  await handleUpdate({ message: { chat: { id: 1 }, text: "spent 200 chai" } }, "1");
  const [t] = (await getDb().select().from(schema.txns).orderBy(schema.txns.id)).slice(-1);
  expect([t.account, t.amount, t.payee, t.direction]).toEqual(["Cash", 20000, "chai", "debit"]);
  expect(sent.at(-1)!.body.text).toContain("₹200</b> to chai");
});
