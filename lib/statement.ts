// Reads rows out of a downloaded statement: a spreadsheet grid (bank accounts) or PDF text (cards). Pure.
// shortcut: generic column and line detection, not yet checked against real ICICI / SBI / Axis statements;
// the import script prints totals so they can be compared with the statement before anything is written.
import { parseDate, payeeKeyOf, toPaise } from "./parse";

export type StmtRow = { date: string; narration: string; amount: number; direction: "debit" | "credit" };

const money = (cell: string | undefined) => {
  const m = /[\d,]+(?:\.\d+)?/.exec(cell ?? "");
  return m ? toPaise(m[0]) : 0;
};

/** A sheet as rows of cell text. Finds the header row, then reads date / narration / debit / credit columns. */
export function parseGrid(grid: string[][]): StmtRow[] {
  const find = (row: string[], re: RegExp) => row.findIndex((c) => re.test(c ?? ""));
  const DESC = /narration|description|remarks|particulars|details/i;
  const h = grid.findIndex((r) => find(r, /date/i) >= 0 && find(r, DESC) >= 0);
  if (h < 0) return [];
  const head = grid[h];
  const date = find(head, /(txn|tran|transaction)\.? ?date/i) >= 0 ? find(head, /(txn|tran|transaction)\.? ?date/i) : find(head, /date/i);
  const desc = find(head, DESC);
  const debit = find(head, /withdrawal|debit/i);
  const credit = find(head, /deposit|credit/i);
  const amount = find(head, /amount/i);
  const type = find(head, /dr ?\/ ?cr|cr ?\/ ?dr|type/i);

  const out: StmtRow[] = [];
  for (const r of grid.slice(h + 1)) {
    const iso = parseDate(r[date] ?? "");
    const narration = (r[desc] ?? "").replace(/\s+/g, " ").trim();
    if (!iso || !narration) continue;
    if (debit >= 0 && credit >= 0 && debit !== credit) {
      if (money(r[debit]) > 0) out.push({ date: iso, narration, amount: money(r[debit]), direction: "debit" });
      else if (money(r[credit]) > 0) out.push({ date: iso, narration, amount: money(r[credit]), direction: "credit" });
    } else if (amount >= 0 && money(r[amount]) > 0) {
      const isCredit = /cr/i.test(`${r[amount]} ${type >= 0 ? r[type] : ""}`);
      out.push({ date: iso, narration, amount: money(r[amount]), direction: isCredit ? "credit" : "debit" });
    }
  }
  return out;
}

/** `pdftotext -layout` output of a card statement: lines that start with a date and end with an amount. */
export function parsePdfText(text: string): StmtRow[] {
  const LINE = /^\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{1,2}[ -][A-Za-z]{3}[ -]\d{2,4})\s+(.+?)\s+([\d,]+\.\d{2})\s*(cr|dr)?\s*$/i;
  const out: StmtRow[] = [];
  for (const line of text.split("\n")) {
    const m = LINE.exec(line);
    const iso = m && parseDate(m[1]);
    if (!m || !iso) continue;
    out.push({ date: iso, narration: m[2].replace(/\s+/g, " ").trim(), amount: toPaise(m[3]), direction: /cr/i.test(m[4] ?? "") ? "credit" : "debit" });
  }
  return out;
}

const NOISE = /^(upi|dr|cr|p2a|p2m|p2p|imps|neft|rtgs|mmt|inb|bil|payment|pay|na|collect|sent|received)$/i;

/** Best payee name and memory key from a statement narration such as "UPI/RAMESH K/ramesh.k@okaxis/Payment/AXIS BANK/1234". */
export function payeeOf(narration: string): { payee: string; payeeKey: string } {
  const vpa = /[\w.-]{2,}@[a-z][a-z0-9]+(?![.\w])/i.exec(narration)?.[0];
  const parts = narration.split(/[/|]|-(?=[A-Z])|\*/).map((p) => p.trim());
  const name = parts.find((p) => /[A-Za-z]{3,}/.test(p) && !NOISE.test(p) && !p.includes("@") && !/\bbank\b/i.test(p) && !/^[A-Z]{4}\d*$/.test(p));
  const payee = (name ?? vpa ?? narration).slice(0, 40).trim() || "Unknown";
  return { payee, payeeKey: payeeKeyOf(vpa ?? payee) };
}

/**
 * Statement rows that no live alert already covers. A live payment (given as its IST day, amount and
 * direction) accounts for one statement row of the same amount within a day either side, since banks
 * post some payments a day late. What is left over was missed by SMS and mail.
 */
export function missedRows<R extends StmtRow>(rows: R[], live: { day: string; amount: number; direction: string }[]): R[] {
  const pool = new Map<string, number>();
  for (const l of live) pool.set(`${l.day}|${l.amount}|${l.direction}`, (pool.get(`${l.day}|${l.amount}|${l.direction}`) ?? 0) + 1);
  const shift = (day: string, by: number) => new Date(Date.parse(`${day}T00:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10);
  return rows.filter((r) => {
    for (const by of [0, -1, 1]) {
      const k = `${shift(r.date, by)}|${r.amount}|${r.direction}`;
      if (pool.get(k)) { pool.set(k, pool.get(k)! - 1); return false; }
    }
    return true;
  });
}
