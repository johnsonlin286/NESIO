import { defineConfig } from "drizzle-kit";

// `npx drizzle-kit generate` membuat file migrasi SQL di ./drizzle dari skema.
// Migrasi dijalankan otomatis saat server start (src/project/db/client.ts).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/project/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://abc:abc_dev@127.0.0.1:5433/abc_words" },
});
