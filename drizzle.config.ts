import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  // Migrations use the direct (unpooled) connection when available.
  dbCredentials: { url: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "" },
});
