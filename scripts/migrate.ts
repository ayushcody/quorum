import { runMigrations } from "../src/db/migrate.ts";

// `pnpm db:migrate`: apply pending migrations to DATABASE_URL (safe to run on every deploy).
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required (local: `pnpm db:up`, then postgres://postgres:dev@localhost:5432/postgres)");
await runMigrations(url);
console.log("migrations applied");
