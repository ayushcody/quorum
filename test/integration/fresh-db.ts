import { randomBytes } from "node:crypto";
import postgres from "postgres";

// A throwaway database per test file, on the local Docker Postgres (`pnpm db:up`).
const adminUrl = process.env.TEST_DATABASE_URL ?? "postgres://postgres:dev@localhost:5432/postgres";

export async function createFreshDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `quorum_test_${randomBytes(4).toString("hex")}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`create database ${name}`);
  } catch (err) {
    await admin.end();
    throw new Error(`Cannot create a test database on ${adminUrl.replace(/:[^:@/]+@/, ":***@")} (${(err as Error).message || (err as { code?: string }).code}). Run \`pnpm db:up\`.`);
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: async () => {
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.end();
    },
  };
}
