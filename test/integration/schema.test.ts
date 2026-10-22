import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.ts";
import { createFreshDatabase } from "./fresh-db.ts";

// S2.1: the schema enforces the money invariants itself (ARCHITECTURE §6), not only the app.
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

const code = async (p: Promise<unknown>) => p.then(() => "ok", (err: { code?: string }) => err.code ?? "error");
const UNIQUE = "23505";
const CHECK = "23514";

async function seedRound() {
  const [member] = await sql`insert into members (display_name, business_name, kind, public_key_jwk) values ('Maya', 'Maya''s Café', 'human', '{"kty":"EC"}') returning id`;
  const [round] = await sql`insert into rounds (title, sku, unit, target_qty, min_members, pledge_deadline_at, delivery_by, supplier_ref, status)
    values ('Beans', 'beans-eth', 'kg', 200, 3, now() + interval '2 days', current_date + 10, 'supplier-1', 'open') returning id`;
  const [mandate] = await sql`insert into mandates (round_id, member_id, max_unit_price_cents, qty_min, qty_max, deadline_at, canonical_json, hash, signature)
    values (${round!.id}, ${member!.id}, 1400, 10, 30, now() + interval '2 days', '{}', ${randomBytes(32).toString("hex")}, 'sig') returning id`;
  const [pledge] = await sql`insert into pledges (mandate_id, round_id, member_id, funding, status, max_exposure_cents)
    values (${mandate!.id}, ${round!.id}, ${member!.id}, 'paypal_wallet', 'authorized', 42000) returning id`;
  return { memberId: member!.id as string, roundId: round!.id as string, pledgeId: pledge!.id as string };
}

describe("migrations", () => {
  it("create every table from ARCHITECTURE §6 on an empty database", async () => {
    const rows = await sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`;
    expect(rows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining(["audit_log", "authorizations", "benchmarks", "demo_signing_keys", "fulfillments", "mandates", "members", "negotiation_turns", "paypal_ops", "pledges", "rounds", "webhook_events"]),
    );
  });

  it("are safe to run twice", async () => {
    await expect(runMigrations(db.url)).resolves.toBeUndefined();
  });
});

describe("money and idempotency invariants in the schema", () => {
  it("rejects a second outbox op with the same business key", async () => {
    const op = (key: string) => sql`insert into paypal_ops (business_key, request_id, kind, mode, request, status) values (${key}, gen_random_uuid(), 'capture', 'deferred', '{}', 'pending')`;
    expect(await code(op("capture:AUTH-1"))).toBe("ok");
    expect(await code(op("capture:AUTH-1"))).toBe(UNIQUE);
  });

  it("rejects capturing more than was authorized, negative money, and non-USD", async () => {
    const { pledgeId } = await seedRound();
    const auth = (id: string, amount: number, captured: number | null, currency = "USD") =>
      sql`insert into authorizations (pledge_id, paypal_authorization_id, amount_cents, currency, status, paypal_expires_at, honor_ends_at, captured_cents)
          values (${pledgeId}, ${id}, ${amount}, ${currency}, 'created', now() + interval '29 days', now() + interval '3 days', ${captured})`;
    expect(await code(auth("A-ok", 1000, 600))).toBe("ok");
    expect(await code(auth("A-over", 1000, 1001))).toBe(CHECK);
    expect(await code(auth("A-neg", -1, null))).toBe(CHECK);
    expect(await code(auth("A-eur", 1000, null, "EUR"))).toBe(CHECK);
    expect(await code(auth("A-ok", 1000, null))).toBe(UNIQUE);
  });

  it("allows one mandate per member per round, with qty_max >= qty_min", async () => {
    const { memberId, roundId } = await seedRound();
    const mandate = (hash: string, min: number, max: number) =>
      sql`insert into mandates (round_id, member_id, max_unit_price_cents, qty_min, qty_max, deadline_at, canonical_json, hash, signature)
          values (${roundId}, ${memberId}, 1400, ${min}, ${max}, now(), '{}', ${hash}, 'sig')`;
    expect(await code(mandate("b".repeat(64), 10, 20))).toBe(UNIQUE);
    const [other] = await sql`insert into members (display_name, business_name, kind, public_key_jwk) values ('Bo', 'Bean There', 'bot', '{}') returning id`;
    expect(await code(sql`insert into mandates (round_id, member_id, max_unit_price_cents, qty_min, qty_max, deadline_at, canonical_json, hash, signature)
      values (${roundId}, ${other!.id}, 1400, 20, 10, now(), '{}', ${"c".repeat(64)}, 'sig')`)).toBe(CHECK);
  });

  it("only knows the funding kinds and round states from DECISIONS D1/D4", async () => {
    const { roundId } = await seedRound();
    expect(await code(sql`update pledges set funding = 'card' where round_id = ${roundId}`)).toBe(CHECK);
    expect(await code(sql`update pledges set funding = 'demo_card' where round_id = ${roundId}`)).toBe("ok");
    for (const status of ["invoiced", "paid_out", "fulfilled"]) {
      expect(await code(sql`update rounds set status = ${status} where id = ${roundId}`), status).toBe("ok");
    }
    expect(await code(sql`update rounds set status = 'bogus' where id = ${roundId}`)).toBe(CHECK);
  });

  it("dedupes webhook events by PayPal event id", async () => {
    const event = sql`insert into webhook_events (paypal_event_id, event_type, resource_id, payload, verified) values ('WH-1', 'PAYMENT.CAPTURE.COMPLETED', 'CAP-1', '{}', true)`;
    expect(await code(event)).toBe("ok");
    expect(await code(sql`insert into webhook_events (paypal_event_id, event_type, resource_id, payload, verified) values ('WH-1', 'PAYMENT.CAPTURE.COMPLETED', 'CAP-1', '{}', true)`)).toBe(UNIQUE);
  });

  it("keeps the audit log append-only", async () => {
    await sql`insert into audit_log (actor, action, data) values ('policy', 'settle', '{}')`;
    expect(await code(sql`update audit_log set action = 'tampered'`)).not.toBe("ok");
    expect(await code(sql`delete from audit_log`)).not.toBe("ok");
    const [row] = await sql`select count(*)::int as n from audit_log where action = 'settle'`;
    expect(row!.n).toBe(1);
  });
});
