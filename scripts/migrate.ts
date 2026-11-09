import { config } from "dotenv";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";

config({ path: ".env.local" });
// Preview builds share the production database variables and must not change its schema.
if (process.env.VERCEL && process.env.VERCEL_ENV !== "production") process.exit(0);
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) throw new Error("Set DATABASE_URL in .env.local (or connect Neon in Vercel)");
await migrate(drizzle(neon(url)), { migrationsFolder: "./drizzle" });
console.log("migrations applied");
