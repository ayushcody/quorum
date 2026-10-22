import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.ts";
import { makePingDb } from "../../src/db/ping.ts";

// Runs against the local Docker Postgres (`pnpm db:up`), so DB code runs here before it runs on Render.
const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres:dev@localhost:5432/postgres";

describe("database health (local Postgres)", () => {
  it("/health reports db: ok against a live database", async () => {
    const ping = makePingDb(url);
    await ping().catch((err: Error & { code?: string }) => {
      const cause = err.message || err.code || err.name;
      throw new Error(`Postgres unreachable at ${url.replace(/:[^:@/]+@/, ":***@")} (${cause}). Run \`pnpm db:up\`.`);
    });
    const app = createApp({ webhookId: undefined, getPublicKey: async () => Promise.reject(new Error("unused")), pingDb: ping, log: () => {} });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", db: "ok" });
  });
});
