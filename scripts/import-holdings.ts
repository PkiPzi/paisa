// Loads what you own, run on your own machine. Replaces the stored holdings of each kind found in the files.
//
//   npx tsx scripts/import-holdings.ts ~/Downloads/groww-mutual-funds.xlsx ~/Downloads/groww-stocks.xlsx          (dry run)
//   npx tsx scripts/import-holdings.ts ~/Downloads/groww-mutual-funds.xlsx ~/Downloads/groww-stocks.xlsx --write
//
// Any sheet with ISIN, name, units/quantity and invested value (or average price) columns works, as does a
// hand-made CSV with the header: isin,name,units,invested
import { config } from "dotenv";
import { inArray } from "drizzle-orm";
import XLSX from "xlsx";
import { parseHoldingsGrid, type HoldingRow } from "../lib/invest";
import { rupees } from "../lib/money";

config({ path: ".env.local" });
const files = process.argv.slice(2).filter((a) => a !== "--write");
if (!files.length) {
  console.error("Usage: npx tsx scripts/import-holdings.ts <files...> [--write]");
  process.exit(1);
}

const found = new Map<string, HoldingRow>();
for (const f of files) {
  const wb = XLSX.readFile(f, { raw: true });
  const rows = wb.SheetNames.flatMap((n) => parseHoldingsGrid(XLSX.utils.sheet_to_json<string[]>(wb.Sheets[n], { header: 1, raw: false, defval: "" })));
  console.log(`${f}: ${rows.length} holdings`);
  rows.forEach((r) => found.set(r.isin, r));
}
if (!found.size) {
  console.error("No holdings recognised. Send me the header row of this file (no amounts needed) so the reader can be fixed.");
  process.exit(1);
}
// ISINs starting INF are mutual fund units; everything else listed here is treated as a share.
const rows = [...found.values()].map((r) => ({ ...r, kind: r.isin.startsWith("INF") ? "mf" : "stock" }));
rows.forEach((r) => console.log(`  ${r.kind.padEnd(5)} ${r.isin}  ${String(r.units).padStart(10)} units  ${rupees(r.invested).padStart(12)} invested  ${r.name}`));
console.log(`Total invested ${rupees(rows.reduce((a, r) => a + r.invested, 0))}`);
if (!process.argv.includes("--write")) {
  console.log("\nDry run: nothing stored. Check the list against Groww, then add --write.");
  process.exit(0);
}

const { getDb, schema } = await import("../db");
const { refreshPrices, portfolio } = await import("../lib/invest");
const db = getDb();
await db.delete(schema.holdings).where(inArray(schema.holdings.kind, [...new Set(rows.map((r) => r.kind))]));
await db.insert(schema.holdings).values(rows.map((r) => ({
  ...r, assetClass: r.kind === "stock" ? "equity" : "other", category: r.kind === "stock" ? "Stock" : "Unclassified",
})));
const priced = await refreshPrices();
const p = portfolio(await db.select().from(schema.holdings));
console.log(`\nStored ${rows.length} holdings; ${priced} priced. Worth ${rupees(p.value)} against ${rupees(p.invested)} invested, ${p.equityPct}% equity.`);
if (priced < rows.length) console.log("Holdings without a price are shown at their invested value until a price feed recognises the ISIN.");
process.exit(0);
