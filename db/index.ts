import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import type { PgDatabase } from "drizzle-orm/pg-core";
import * as schema from "./schema";

// Neon HTTP has no interactive transactions, so writes are single statements made safe by unique keys.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<any, typeof schema>;

let instance: Db | null = null;

// Local development without Neon: PGLITE_DIR=.pglite runs an embedded Postgres (see scripts/dev-db.ts).
// The module names are built at run time so the production bundle never includes PGlite.
if (process.env.PGLITE_DIR && process.env.NODE_ENV !== "production") {
  const [pglite, driver] = ["@electric-sql/pglite", "drizzle-orm/pglite"];
  const { PGlite } = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ pglite);
  const { drizzle: local } = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ driver);
  instance = local(new PGlite(process.env.PGLITE_DIR), { schema }) as Db;
}

export function getDb(): Db {
  if (!instance) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    instance = drizzle(neon(url), { schema }) as unknown as Db;
  }
  return instance;
}
export { schema };
