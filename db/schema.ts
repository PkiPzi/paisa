import { date, doublePrecision, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

// All money is integer paise.

/** Every forwarded mail, kept raw so a better parser can be re-run over old mail. */
export const emails = pgTable("emails", {
  id: text().primaryKey(), // Gmail message id
  sender: text().notNull(),
  subject: text().notNull(),
  receivedAt: timestamp({ withTimezone: true }).notNull(),
  body: text().notNull(),
  kind: text().notNull(), // txn | bill | receipt | ignored
});

export const txns = pgTable("txns", {
  id: serial().primaryKey(),
  emailId: text().unique(),
  at: timestamp({ withTimezone: true }).notNull(),
  amount: integer().notNull(),
  direction: text().notNull(), // debit | credit
  account: text().notNull(), // e.g. "ICICI a/c 1234"
  payee: text().notNull(),
  payeeKey: text().notNull(), // UPI id, else the normalised name
  category: text(), // null = waiting for an answer
  source: text(), // rule | memory | receipt | ai | user
  myShare: integer(), // set once split; spending counts this instead of amount
  splitWith: text(), // who it was split or settled with, for display
  tag: text(), // optional sub-label typed by the user, e.g. "Wi-Fi" under Bills; totals still go by category
  tgMessageId: integer(),
});

/** Payee memory: once labelled, a payee is never asked about again. */
export const payees = pgTable("payees", {
  key: text().primaryKey(),
  category: text(),
  tag: text(), // the sub-label this payee usually gets
  splitTarget: text(), // "g:<circleId>" or "p:<personId>": who this payee is usually shared or settled with
  splitLabel: text(),
});

/** Merchant receipt mails (Rapido, Swiggy, ...) used to label a matching bank debit. */
export const receipts = pgTable("receipts", {
  emailId: text().primaryKey(),
  merchant: text().notNull(),
  category: text().notNull(),
  amount: integer().notNull(),
  at: timestamp({ withTimezone: true }).notNull(),
});

export const bills = pgTable("bills", {
  emailId: text().primaryKey(),
  card: text().notNull(),
  amount: integer().notNull(),
  dueDate: date().notNull(), // YYYY-MM-DD
});

/** What you own. Replaced wholesale by scripts/import-holdings.ts; prices refreshed daily. */
export const holdings = pgTable("holdings", {
  isin: text().primaryKey(),
  name: text().notNull(),
  kind: text().notNull(), // mf | stock
  assetClass: text().notNull(), // equity | debt | hybrid | gold | other
  category: text().notNull(), // AMFI category such as "Large Cap Fund", or "Stock"
  symbol: text(), // Yahoo symbol for stocks, looked up once from the ISIN
  units: doublePrecision().notNull(),
  invested: integer().notNull(), // paise
  price: doublePrecision(), // rupees per unit; null until the first refresh
  priceAt: text(),
  importedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

// ---------- the built-in "who owes whom" ledger ----------
export const people = pgTable("people", {
  id: serial().primaryKey(),
  name: text().notNull().unique(),
});

/** A named set of people you often split with, e.g. "Flat". */
export const circles = pgTable("circles", {
  id: serial().primaryKey(),
  name: text().notNull().unique(),
  memberIds: text().notNull(), // JSON array of people.id
});

/** One line of the ledger. Positive: they owe you. Negative: you owe them, or they paid you back. */
export const dues = pgTable("dues", {
  id: serial().primaryKey(),
  personId: integer().notNull(),
  amount: integer().notNull(),
  note: text().notNull(),
  at: timestamp({ withTimezone: true }).notNull(),
  txnId: integer(), // the payment this came from, if any
});
