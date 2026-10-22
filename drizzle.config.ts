import { defineConfig } from "drizzle-kit";

// `pnpm db:generate` writes SQL migrations from src/db/schema.ts; `pnpm db:migrate` applies them.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://postgres:dev@localhost:5432/postgres" },
});
