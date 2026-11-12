// Import of statements, run on your own machine: once for the past year, then whenever you want to
// catch payments the live alerts missed.
//
//   npx tsx scripts/import-statements.ts "ICICI a/c 1234" ~/Downloads/icici-2026.xls            (dry run)
//   npx tsx scripts/import-statements.ts "ICICI a/c 1234" ~/Downloads/icici-2026.xls --write
//
// Bank accounts: the .xls / .xlsx / .csv export. Cards: the statement PDFs (PDF_PASSWORD=... if locked).
// A dry run prints totals to compare with the statement. --write stores the rows, labelled by rule, payee
// memory and Groq; it sends no Telegram messages and nothing to Splitwise.
import { config } from "dotenv";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { and, gte, like, not } from "drizzle-orm";
import XLSX from "xlsx";
import { missedRows, parseGrid, parsePdfText, payeeOf, type StmtRow } from "../lib/statement";
import { istDay, rupees } from "../lib/money";

config({ path: ".env.local" });
const args = process.argv.slice(2).filter((a) => a !== "--write");
const write = process.argv.includes("--write");
const [account, ...files] = args;
if (!account || !files.length || /\.(xlsx?|csv|pdf)$/i.test(account)) {
  console.error('Usage: npx tsx scripts/import-statements.ts "<account label, e.g. ICICI a/c 1234>" <files...> [--write]');
  process.exit(1);
}

const rows: StmtRow[] = [];
for (const f of files) {
  let found: StmtRow[];
  if (/\.pdf$/i.test(f)) {
    const pw = process.env.PDF_PASSWORD ? ["-upw", process.env.PDF_PASSWORD] : [];
    found = parsePdfText(execFileSync("pdftotext", ["-layout", ...pw, f, "-"], { encoding: "utf8", maxBuffer: 64e6 }));
  } else {
    const wb = XLSX.readFile(f, { raw: true }); // raw: keep "10/11/2026" as text instead of guessing month-first dates
    found = wb.SheetNames.flatMap((n) => parseGrid(XLSX.utils.sheet_to_json<string[]>(wb.Sheets[n], { header: 1, raw: false, dateNF: "dd/mm/yyyy", defval: "" })));
  }
  console.log(`${f}: ${found.length} rows`);
  rows.push(...found);
}
if (!rows.length) {
  console.error("No transactions recognised. Send me a few (redacted) lines of this file's layout so the reader can be fixed.");
  process.exit(1);
}

const sum = (d: string) => rows.filter((r) => r.direction === d).reduce((a, r) => a + r.amount, 0);
const dates = rows.map((r) => r.date).sort();
console.log(`\n${account}: ${rows.length} rows, ${dates[0]} to ${dates.at(-1)}`);
console.log(`  money out ${rupees(sum("debit"))} in ${rows.filter((r) => r.direction === "debit").length} rows`);
console.log(`  money in  ${rupees(sum("credit"))} in ${rows.filter((r) => r.direction === "credit").length} rows`);
console.log("  first rows:");
rows.slice(0, 5).forEach((r) => console.log(`    ${r.date}  ${r.direction.padEnd(6)} ${rupees(r.amount).padStart(12)}  ${payeeOf(r.narration).payee}`));
if (!write) {
  console.log("\nDry run: nothing stored. Check the totals against the statement, then add --write.");
  process.exit(0);
}

// The database modules read env at import time, so they load after dotenv.
const { getDb, schema } = await import("../db");
const { guessCategories } = await import("../lib/clients");
const db = getDb();
const { txns, payees } = schema;

// A payment already recorded from a live SMS or mail of the same bank is not stored again; statement rows
// with no live match are kept, so an import also fills in whatever the alerts missed.
const bank = account.split(" ")[0];
const live = (await db.select({ at: txns.at, amount: txns.amount, direction: txns.direction, account: txns.account }).from(txns)
  .where(and(not(like(txns.emailId, "stmt:%")), gte(txns.at, new Date(`${dates[0]}T00:00:00+05:30`)))))
  .filter((t) => t.account.split(" ")[0] === bank)
  .map((t) => ({ day: istDay(t.at), amount: t.amount, direction: t.direction }));
const kept = missedRows(rows, live);
const seen = new Map<string, number>();
const items = kept.map((r) => {
  // Identical rows on one day are real repeats; number them so a re-import or overlapping file adds nothing.
  const base = `${account}|${r.date}|${r.amount}|${r.direction}|${r.narration}`;
  const n = (seen.get(base) ?? 0) + 1;
  seen.set(base, n);
  return { ...r, ...payeeOf(r.narration), emailId: "stmt:" + createHash("sha1").update(`${base}|${n}`).digest("hex") };
});

const memory = new Map((await db.select().from(payees)).map((p) => [p.key, p.category]));
const label = new Map<string, { category: string; source: string }>();
const unknown = new Map<string, (typeof items)[number]>();
for (const it of items) {
  if (it.direction === "debit" && /credit ?card|\bcred\b/i.test(it.narration)) label.set(it.emailId, { category: "Card bill", source: "rule" });
  else if (memory.get(it.payeeKey)) label.set(it.emailId, { category: memory.get(it.payeeKey)!, source: "memory" });
  else if (!unknown.has(`${it.direction}|${it.payeeKey}`)) unknown.set(`${it.direction}|${it.payeeKey}`, it);
}
// One guess per distinct payee, 20 per call, paced for the free tier's per-minute limit.
const guesses = new Map<string, string>();
const todo = [...unknown];
for (let i = 0; i < todo.length; i += 20) {
  const batch = todo.slice(i, i + 20);
  const out = await guessCategories(batch.map(([, it]) => it));
  out.forEach((g, j) => { if (g && g.confidence >= 0.6) guesses.set(batch[j][0], g.category); });
  process.stdout.write(`\r  labelling payees ${Math.min(i + 20, todo.length)}/${todo.length}`);
  if (i + 20 < todo.length) await new Promise((r) => setTimeout(r, 3000));
}

let stored = 0;
for (let i = 0; i < items.length; i += 100) {
  const res = await db.insert(txns).values(items.slice(i, i + 100).map((it) => {
    const l = label.get(it.emailId) ?? (guesses.has(`${it.direction}|${it.payeeKey}`) ? { category: guesses.get(`${it.direction}|${it.payeeKey}`)!, source: "ai" } : null);
    return {
      emailId: it.emailId, at: new Date(`${it.date}T12:00:00+05:30`), amount: it.amount, direction: it.direction, account,
      payee: it.payee, payeeKey: it.payeeKey, category: l?.category ?? null, source: l?.source ?? null,
    };
  })).onConflictDoNothing().returning({ id: txns.id });
  stored += res.length;
}
console.log(`\nStored ${stored} new rows (${items.length - stored} already present${rows.length - kept.length ? `, ${rows.length - kept.length} already recorded from live alerts` : ""}).`);
console.log("Open /backfill on the dashboard to pick the shared ones.");
process.exit(0);
