import { createHash } from "node:crypto";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import {
  canonicalJson,
  mandateHash,
  signMandate,
  toMandatePayload,
  verifyMandate,
  type MandatePayload,
  type PublicKeyJwk,
  type SigningKey,
  type VerifiedMandate,
} from "./mandate-sign.ts";

// S2.3: a member's mandate is bound to them by an ECDSA P-256 signature over its canonical JSON.
// Its sha256 hash becomes the PayPal order's custom_id, so policy can check the hold matches the mandate.

const subtle = globalThis.crypto.subtle;
type KeyPair = { privateKey: SigningKey; publicKeyJwk: PublicKeyJwk };

async function newKeyPair(): Promise<KeyPair> {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return { privateKey: pair.privateKey, publicKeyJwk: await subtle.exportKey("jwk", pair.publicKey) };
}

let member: KeyPair;
let other: KeyPair;
beforeAll(async () => {
  member = await newKeyPair();
  other = await newKeyPair();
});

const BASE = {
  roundId: "00000000-0000-4000-8000-00000000d001",
  memberId: "00000000-0000-4000-8000-0000000b0001",
  maxUnitPriceCents: 1_400n,
  qtyMin: 10,
  qtyMax: 30,
  deadlineAt: new Date("2026-10-24T12:00:00.000Z"),
};

const arbInput = fc
  .record({
    roundId: fc.uuid(),
    memberId: fc.uuid(),
    maxUnitPriceCents: fc.bigInt({ min: 1n, max: 10_000_000n }),
    qtyMin: fc.integer({ min: 1, max: 1_000 }),
    extra: fc.integer({ min: 0, max: 1_000 }),
    deadlineMs: fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 0, 1) }),
  })
  .map(({ extra, deadlineMs, ...rest }) => ({ ...rest, qtyMax: rest.qtyMin + extra, deadlineAt: new Date(deadlineMs) }));

describe("canonicalJson", () => {
  it("does not depend on key order, at any depth", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string({ maxLength: 6 }), fc.oneof(fc.string(), fc.integer(), fc.boolean())), (obj) => {
        const reversed = Object.fromEntries(Object.entries(obj).reverse());
        expect(canonicalJson({ a: obj, b: [obj] })).toBe(canonicalJson({ b: [reversed], a: reversed }));
      }),
      { numRuns: 300 },
    );
  });

  it("is compact JSON with keys sorted", () => {
    expect(canonicalJson({ b: 1, a: "x", c: { z: true, y: null } })).toBe('{"a":"x","b":1,"c":{"y":null,"z":true}}');
  });

  it("refuses values that have no single canonical form", () => {
    for (const bad of [1.5, Number.NaN, 2 ** 60, undefined, 1n, new Date(0), () => 1]) {
      expect(() => canonicalJson({ v: bad }), String(bad)).toThrow();
    }
  });
});

describe("signMandate / verifyMandate", () => {
  it("accepts a mandate signed by the member's key and returns its hash and canonical form", async () => {
    const payload = toMandatePayload(BASE);
    const signature = await signMandate(payload, member.privateKey);
    const result = await verifyMandate({ payload, signature, publicKeyJwk: member.publicKeyJwk });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.canonicalJson).toBe(canonicalJson(payload));
    expect(result.hash).toBe(createHash("sha256").update(result.canonicalJson).digest("hex"));
    expect(result.hash).toBe(await mandateHash(payload));
    expect(result.mandate).toMatchObject({ roundId: BASE.roundId, memberId: BASE.memberId, maxUnitPriceCents: 1_400n, qtyMin: 10, qtyMax: 30, hash: result.hash });
    expect(result.mandate.deadlineAt.toISOString()).toBe(BASE.deadlineAt.toISOString());
  });

  it("fits PayPal's custom_id (≤ 127 chars) and is stable for the same mandate", async () => {
    const hash = await mandateHash(toMandatePayload(BASE));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await mandateHash(toMandatePayload({ ...BASE }))).toBe(hash);
  });

  it("rejects any single-field change after signing", async () => {
    await fc.assert(
      fc.asyncProperty(arbInput, fc.constantFrom("roundId", "memberId", "maxUnitPriceCents", "qtyMin", "qtyMax", "deadlineAt", "currency", "v"), async (input, field) => {
        const payload = toMandatePayload(input);
        const signature = await signMandate(payload, member.privateKey);
        const tampered = { ...payload } as Record<string, unknown>;
        const bump: Record<string, () => unknown> = {
          roundId: () => `${payload.roundId}x`,
          memberId: () => `${payload.memberId}x`,
          maxUnitPriceCents: () => String(BigInt(payload.maxUnitPriceCents) + 1n),
          qtyMin: () => payload.qtyMin + 1,
          qtyMax: () => payload.qtyMax + 1,
          deadlineAt: () => new Date(Date.parse(payload.deadlineAt) + 1_000).toISOString(),
          currency: () => "EUR",
          v: () => 2,
        };
        tampered[field] = bump[field]!();
        const result = await verifyMandate({ payload: tampered, signature, publicKeyJwk: member.publicKeyJwk });
        expect(result.ok, field).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("rejects a valid signature from a different member's key", async () => {
    const payload = toMandatePayload(BASE);
    const signature = await signMandate(payload, other.privateKey);
    expect(await verifyMandate({ payload, signature, publicKeyJwk: member.publicKeyJwk })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects malformed payloads, extra fields, garbage signatures and bad keys without throwing", async () => {
    const payload = toMandatePayload(BASE);
    const signature = await signMandate(payload, member.privateKey);
    const verify = (p: unknown, s = signature, k: PublicKeyJwk = member.publicKeyJwk) => verifyMandate({ payload: p, signature: s, publicKeyJwk: k });
    expect(await verify({ ...payload, extra: "smuggled" })).toEqual({ ok: false, reason: "malformed_payload" });
    expect(await verify({ ...payload, maxUnitPriceCents: "14.00" })).toEqual({ ok: false, reason: "malformed_payload" });
    expect(await verify(null)).toEqual({ ok: false, reason: "malformed_payload" });
    expect(await verify({ ...payload, qtyMin: 40 })).toEqual({ ok: false, reason: "invalid_mandate" });
    expect(await verify(payload, "not-base64!!")).toEqual({ ok: false, reason: "bad_signature" });
    expect(await verify(payload, signature, { kty: "EC", crv: "P-256", x: "AAAA", y: "AAAA" })).toEqual({ ok: false, reason: "bad_key" });
  });

  it("only this module can produce a VerifiedMandate", () => {
    const plain = { roundId: "r", memberId: "m", maxUnitPriceCents: 1n, qtyMin: 1, qtyMax: 1, deadlineAt: new Date(), hash: "h" };
    // @ts-expect-error a plain object is not a VerifiedMandate: the brand is only set by verifyMandate
    const forged: VerifiedMandate = plain;
    expect(forged).toBe(plain);
    const payload: MandatePayload = toMandatePayload(BASE);
    expect(payload.currency).toBe("USD");
  });
});
