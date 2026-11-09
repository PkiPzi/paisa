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
  splitwiseId: text(),
  splitWith: text(),
  tgMessageId: integer(),
});

/** Payee memory: once labelled, a payee is never asked about again. */
export const payees = pgTable("payees", {
  key: text().primaryKey(),
  category: text(),
  splitTarget: text(), // "g:<groupId>" or "f:<friendId>" when this payee is usually shared
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
