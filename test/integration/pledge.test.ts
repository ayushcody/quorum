import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.ts";
import { createDb } from "../../src/db/client.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import { authorizations, demoSigningKeys, members, paypalOps, pledges, rounds } from "../../src/db/schema.ts";
import { signMandate, toMandatePayload, type PublicKeyJwk, type SigningKey } from "../../src/pledge/mandate-sign.ts";
import { pledgeAsBot } from "../../src/pledge/service.ts";
import { FakePayPal } from "../../src/paypal/fake.ts";
import { createFreshDatabase } from "./fresh-db.ts";

// S2.5: a member signs a mandate, Quorum creates an AUTHORIZE order sized to their maximum exposure,
// PayPal (v6 popup) approves it, and Quorum authorizes. Bots skip approval, on demo rounds only (D4).
const T0 = new Date("2026-10-22T12:00:00.000Z");
const HOUR = 3_600_000;

let fresh: Awaited<ReturnType<typeof createFreshDatabase>>;
let handle: ReturnType<typeof createDb>;
let port: FakePayPal;
let app: ReturnType<typeof createApp>;
const now = () => T0;

beforeAll(async () => {
  fresh = await createFreshDatabase();
  await runMigrations(fresh.url);
  handle = createDb(fresh.url, { max: 5 });
});
afterAll(async () => {
  await handle?.close();
  await fresh?.drop();
});

function freshApp() {
  port = new FakePayPal();
  app = createApp({
    webhookId: undefined,
    getPublicKey: async () => Promise.reject(new Error("unused")),
    log: () => {},
    pledges: { db: handle.db, port, now, paypalClientId: "sb-client-id" },
  });
  return app;
}

async function newRound(o: { isDemo?: boolean; status?: string; deadlineMs?: number } = {}) {
  const [round] = await handle.db
    .insert(rounds)
    .values({
      title: "Beans",
      sku: "beans",
      unit: "kg",
      targetQty: 50,
      minMembers: 2,
      pledgeDeadlineAt: new Date(T0.getTime() + (o.deadlineMs ?? 48 * HOUR)),
      deliveryBy: "2026-11-01",
      supplierRef: "s",
      status: o.status ?? "open",
      isDemo: o.isDemo ?? false,
    })
    .returning();
  return round!;
}

async function newKeys(): Promise<{ privateKey: SigningKey; publicKeyJwk: PublicKeyJwk }> {
  const pair = await globalThis.crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return { privateKey: pair.privateKey, publicKeyJwk: await globalThis.crypto.subtle.exportKey("jwk", pair.publicKey) };
}

const post = (path: string, body: unknown) => app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

async function register(keys: { publicKeyJwk: PublicKeyJwk }) {
  const res = await post("/api/members", { displayName: "Maya", businessName: "Maya's Café", publicKeyJwk: keys.publicKeyJwk });
  expect(res.status).toBe(201);
  return ((await res.json()) as { memberId: string }).memberId;
}

async function signedPledge(roundId: string, memberId: string, keys: { privateKey: SigningKey }, o: { max?: bigint; qtyMax?: number } = {}) {
  const payload = toMandatePayload({ roundId, memberId, maxUnitPriceCents: o.max ?? 1_400n, qtyMin: 10, qtyMax: o.qtyMax ?? 30, deadlineAt: new Date(T0.getTime() + 47 * HOUR) });
  return { memberId, payload, signature: await signMandate(payload, keys.privateKey) };
}

describe("GET /api/config", () => {
  it("gives the browser the public client id and the sandbox v6 SDK URL, never a secret", async () => {
    const res = await freshApp().request("/api/config");
    expect(await res.json()).toEqual({ paypalClientId: "sb-client-id", paypalSdkUrl: "https://www.sandbox.paypal.com/web-sdk/v6/core" });
  });
});

describe("human pledge: sign → order → popup approval → authorize", () => {
  it("creates an AUTHORIZE order for the maximum exposure, bound to the mandate hash, via one outbox row", async () => {
    freshApp();
    const round = await newRound();
    const keys = await newKeys();
    const memberId = await register(keys);

    const res = await post(`/api/rounds/${round.id}/pledges`, await signedPledge(round.id, memberId, keys));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { pledgeId: string; orderId: string; mandateHash: string };
    expect(body.orderId).toMatch(/^ORDER-/);

    const [pledge] = await handle.db.select().from(pledges).where(eq(pledges.id, body.pledgeId));
    expect(pledge).toMatchObject({ status: "order_created", funding: "paypal_wallet", paypalOrderId: body.orderId, maxExposureCents: 42_000n });
    const creates = port.calls.filter((c) => c.kind === "create_order");
    expect(creates).toHaveLength(1);
    expect(creates[0]!.params).toEqual({ amountCents: "42000", customId: body.mandateHash, invoiceId: body.pledgeId, funding: "paypal_wallet" });
    const ops = await handle.db.select().from(paypalOps).where(eq(paypalOps.businessKey, `create_order:${body.pledgeId}`));
    expect(ops).toHaveLength(1);
  });

  it("is idempotent: the same signed mandate again returns the same pledge and order, with no second order", async () => {
    freshApp();
    const round = await newRound();
    const keys = await newKeys();
    const pledge = await signedPledge(round.id, await register(keys), keys);
    const first = (await (await post(`/api/rounds/${round.id}/pledges`, pledge)).json()) as { pledgeId: string; orderId: string };
    const again = await post(`/api/rounds/${round.id}/pledges`, pledge);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ pledgeId: first.pledgeId, orderId: first.orderId });
    expect(port.calls.filter((c) => c.kind === "create_order")).toHaveLength(1);
  });

  it("authorizes after approval: authorization row with the 72 h honor period, pledge authorized, and once only", async () => {
    freshApp();
    const round = await newRound();
    const keys = await newKeys();
    const { pledgeId } = (await (await post(`/api/rounds/${round.id}/pledges`, await signedPledge(round.id, await register(keys), keys))).json()) as { pledgeId: string };

    const res = await post(`/api/pledges/${pledgeId}/authorize`, {});
    expect(res.status).toBe(200);
    const { authorizationId } = (await res.json()) as { authorizationId: string };
    const [auth] = await handle.db.select().from(authorizations).where(eq(authorizations.pledgeId, pledgeId));
    expect(auth).toMatchObject({ paypalAuthorizationId: authorizationId, amountCents: 42_000n, status: "created" });
    expect(auth!.honorEndsAt.getTime()).toBe(T0.getTime() + 72 * HOUR);
    const [pledge] = await handle.db.select().from(pledges).where(eq(pledges.id, pledgeId));
    expect(pledge!.status).toBe("authorized");

    const again = await post(`/api/pledges/${pledgeId}/authorize`, {});
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ authorizationId });
    expect(port.calls.filter((c) => c.kind === "authorize_order")).toHaveLength(1);
  });

  it("refuses a forged or mismatched mandate without creating anything", async () => {
    freshApp();
    const round = await newRound();
    const maya = await newKeys();
    const mallory = await newKeys();
    const memberId = await register(maya);
    const forged = await signedPledge(round.id, memberId, mallory); // signed with someone else's key
    const otherRound = await newRound();
    const mismatched = await signedPledge(otherRound.id, memberId, maya); // payload names another round

    expect((await post(`/api/rounds/${round.id}/pledges`, forged)).status).toBe(401);
    expect((await post(`/api/rounds/${round.id}/pledges`, mismatched)).status).toBe(400);
    expect((await post(`/api/rounds/${round.id}/pledges`, { ...forged, signature: "garbage" })).status).toBe(401);
    expect((await post(`/api/rounds/${round.id}/pledges`, { memberId, payload: { nope: 1 }, signature: "x" })).status).toBe(400);
    expect(port.calls).toHaveLength(0);
    expect(await handle.db.select().from(pledges).where(eq(pledges.roundId, round.id))).toHaveLength(0);
  });

  it("refuses pledges to a round that is not open or is past its pledge deadline", async () => {
    freshApp();
    const keys = await newKeys();
    const memberId = await register(keys);
    const locked = await newRound({ status: "locked" });
    const late = await newRound({ deadlineMs: -HOUR });
    expect((await post(`/api/rounds/${locked.id}/pledges`, await signedPledge(locked.id, memberId, keys))).status).toBe(409);
    expect((await post(`/api/rounds/${late.id}/pledges`, await signedPledge(late.id, memberId, keys))).status).toBe(409);
    expect((await post(`/api/rounds/00000000-0000-4000-8000-000000000000/pledges`, await signedPledge("00000000-0000-4000-8000-000000000000", memberId, keys))).status).toBe(404);
    expect(port.calls).toHaveLength(0);
  });
});

describe("bot pledge (demo mode only, DECISIONS D4)", () => {
  async function newBot() {
    const keys = await newKeys();
    const [bot] = await handle.db.insert(members).values({ displayName: "Bot", businessName: "Bot Café", kind: "bot", publicKeyJwk: keys.publicKeyJwk }).returning();
    await handle.db.insert(demoSigningKeys).values({ memberId: bot!.id, privateKeyJwk: await globalThis.crypto.subtle.exportKey("jwk", keys.privateKey) });
    return bot!.id;
  }
  const mandate = { maxUnitPriceCents: 1_300n, qtyMin: 5, qtyMax: 20, deadlineAt: new Date(T0.getTime() + 47 * HOUR) };

  it("authorizes in one card order with no approval step, on a demo round", async () => {
    freshApp();
    const round = await newRound({ isDemo: true });
    const result = await pledgeAsBot({ db: handle.db, port, now }, { roundId: round.id, memberId: await newBot(), ...mandate });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [pledge] = await handle.db.select().from(pledges).where(eq(pledges.id, result.pledgeId));
    expect(pledge).toMatchObject({ status: "authorized", funding: "demo_card", maxExposureCents: 26_000n });
    expect(port.calls.map((c) => c.kind)).toEqual(["create_order"]);
    expect(port.calls[0]!.params).toMatchObject({ funding: "demo_card", amountCents: "26000" });
    const [auth] = await handle.db.select().from(authorizations).where(eq(authorizations.pledgeId, result.pledgeId));
    expect(auth!.paypalAuthorizationId).toBe(result.authorizationId);
  });

  it("refuses the card path on a non-demo round, and sends nothing", async () => {
    freshApp();
    const round = await newRound({ isDemo: false });
    const result = await pledgeAsBot({ db: handle.db, port, now }, { roundId: round.id, memberId: await newBot(), ...mandate });
    expect(result).toEqual({ ok: false, error: "not_demo_round" });
    expect(port.calls).toHaveLength(0);
  });
});
