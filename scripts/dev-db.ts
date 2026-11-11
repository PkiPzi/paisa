// Local preview only: builds an embedded Postgres in .pglite and fills it with made-up transactions.
//   npx tsx scripts/dev-db.ts && PGLITE_DIR=.pglite npm run dev
import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../db/schema";

rmSync(".pglite", { recursive: true, force: true });
const db = drizzle(new PGlite(".pglite"), { schema });
await migrate(db, { migrationsFolder: "./drizzle" });

const now = Date.now();
const day = 86_400_000;
const sample: [string, number, string | null, string][] = [
  ["Swiggy", 38900, "Food", "Axis card 9876"], ["ramesh.k@okaxis", 8700, null, "ICICI a/c 1234"], ["Zepto", 61200, "Groceries", "ICICI a/c 1234"],
  ["Truffles", 184000, "Food", "ICICI card 5555"], ["Rapido", 11200, "Ride", "ICICI a/c 1234"], ["Amazon", 249900, "Shopping", "ICICI card 5555"],
  ["Airtel", 79900, "Bills", "Axis card 9876"], ["Netflix", 64900, "Subscriptions", "ICICI card 5555"], ["PVR Cinemas", 72000, "Fun", "ICICI a/c 1234"],
  ["Apollo Pharmacy", 43500, "Health", "SBI a/c 4321"], ["Uber", 32400, "Ride", "Axis card 9876"], ["sunita.pg@ybl", 1800000, "Rent", "SBI a/c 4321"],
];
const rows = Array.from({ length: 64 }, (_, i) => {
  const [payee, amount, category, account] = sample[(i * 7) % sample.length];
  const scale = payee.includes("@ybl") ? 1 : 0.6 + ((i * 37) % 80) / 100;
  return {
    at: new Date(now - (i % 2 ? 0 : 30 * day) - ((i * 11) % 10) * day - (i % 9) * 3_600_000),
    amount: Math.round((amount * scale) / 100) * 100, direction: "debit", account, payee, category, source: category ? "memory" : null,
    payeeKey: payee.toLowerCase(), myShare: null as number | null, splitWith: null as string | null,
  };
}).filter((r, i) => !r.payee.includes("@ybl") || i < 24);
Object.assign(rows[3], { myShare: Math.round(rows[3].amount / 4), splitWith: "Flat 302" });
await db.insert(schema.txns).values([
  ...rows,
  { at: new Date(now - 2 * day), amount: 50000, direction: "credit", account: "ICICI a/c 1234", payee: "Aman Verma", payeeKey: "aman", category: "Settle-up", source: "user" },
  { at: new Date(now - 4 * day), amount: 24900, direction: "credit", account: "ICICI card 5555", payee: "Amazon", payeeKey: "amazon", category: "Refund", source: "user" },
]);
await db.insert(schema.bills).values([
  { emailId: "demo-1", card: "ICICI card 5555", amount: 1840000, dueDate: new Date(now + 2 * day).toISOString().slice(0, 10) },
  { emailId: "demo-2", card: "Axis card 9876", amount: 612000, dueDate: new Date(now + 12 * day).toISOString().slice(0, 10) },
]);
const [aman, riya, karan] = await db.insert(schema.people).values([{ name: "Aman" }, { name: "Riya" }, { name: "Karan" }]).returning();
await db.insert(schema.circles).values({ name: "Flat 302", memberIds: JSON.stringify([aman.id, riya.id, karan.id]) });
await db.insert(schema.dues).values([
  { personId: aman.id, amount: 184000, note: "Truffles", at: new Date(now - 3 * day) }, { personId: aman.id, amount: -50000, note: "Settle-up", at: new Date(now - 2 * day) },
  { personId: riya.id, amount: 62000, note: "Zepto", at: new Date(now - 5 * day) }, { personId: karan.id, amount: -45000, note: "he paid for the cab", at: new Date(now - day) },
]);
console.log("demo database ready in .pglite");
