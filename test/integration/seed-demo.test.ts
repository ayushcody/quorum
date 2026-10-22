import { createPublicKey, createPrivateKey, sign, verify } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.ts";
import { seedDemo } from "../../scripts/seed-demo.ts";
import { createFreshDatabase } from "./fresh-db.ts";

let db: Awaited<ReturnType<typeof createFreshDatabase>>;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createFreshDatabase();
  await runMigrations(db.url);
  sql = postgres(db.url, { max: 2, onnotice: () => {} });
});
afterAll(async () => {
  await sql?.end();
  await db?.drop();
});

describe("seed:demo", () => {
  it("creates one open demo round and bot members whose stored keys are a matching P-256 pair", async () => {
    await seedDemo(db.url);
    const rounds = await sql`select status, is_demo, target_qty, min_members from rounds`;
    expect(rounds).toEqual([{ status: "open", is_demo: true, target_qty: 200, min_members: 3 }]);

    const bots = await sql`select m.public_key_jwk, k.private_key_jwk from members m join demo_signing_keys k on k.member_id = m.id where m.kind = 'bot'`;
    expect(bots.length).toBeGreaterThanOrEqual(3);
    for (const bot of bots) {
      const message = Buffer.from("mandate-hash");
      const signature = sign("sha256", message, createPrivateKey({ key: bot.private_key_jwk, format: "jwk" }));
      expect(verify("sha256", message, createPublicKey({ key: bot.public_key_jwk, format: "jwk" }), signature)).toBe(true);
    }
  });

  it("is idempotent: running it again adds nothing and keeps the same keys", async () => {
    const before = await sql`select id, public_key_jwk from members order by id`;
    await seedDemo(db.url);
    const after = await sql`select id, public_key_jwk from members order by id`;
    expect(after).toEqual(before);
    const [rounds] = await sql`select count(*)::int as n from rounds`;
    expect(rounds!.n).toBe(1);
  });
});
