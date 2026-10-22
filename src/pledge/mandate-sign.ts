// Type-only: erased at build time, so this module runs unchanged in the browser (S2.5 signs there).
import type { webcrypto } from "node:crypto";
import { z } from "zod";
import { validateMandate, type Mandate } from "../policy/mandate.ts";

// A mandate is bound to its member by an ECDSA P-256 / SHA-256 signature over its canonical JSON.
// sha256(canonical JSON) is the mandate hash: stored in mandates.hash and sent as the PayPal order's
// custom_id, so the settlement preflight can check a hold belongs to exactly this mandate.
// WebCrypto only (globalThis.crypto.subtle): the same bytes are signed in the browser and verified here.

export type SigningKey = webcrypto.CryptoKey;
export type PublicKeyJwk = webcrypto.JsonWebKey;

const subtle = globalThis.crypto.subtle;
const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

// Exactly what is signed. Money and dates travel as strings so the encoding has one form.
const payloadSchema = z
  .object({
    v: z.literal(1),
    roundId: z.string().min(1),
    memberId: z.string().min(1),
    maxUnitPriceCents: z.string().regex(/^[1-9]\d*$/),
    qtyMin: z.number(),
    qtyMax: z.number(),
    deadlineAt: z.iso.datetime(),
    currency: z.literal("USD"),
  })
  .strict();

export type MandatePayload = z.infer<typeof payloadSchema>;

declare const verified: unique symbol;
// Only verifyMandate can produce one: a VerifiedMandate is proof the signature checked out.
export type VerifiedMandate = Mandate & { readonly roundId: string; readonly hash: string; readonly [verified]: true };

export function toMandatePayload(m: {
  roundId: string;
  memberId: string;
  maxUnitPriceCents: bigint;
  qtyMin: number;
  qtyMax: number;
  deadlineAt: Date;
}): MandatePayload {
  return {
    v: 1,
    roundId: m.roundId,
    memberId: m.memberId,
    maxUnitPriceCents: m.maxUnitPriceCents.toString(),
    qtyMin: m.qtyMin,
    qtyMax: m.qtyMax,
    deadlineAt: m.deadlineAt.toISOString(),
    currency: "USD",
  };
}

// Sorted keys, no whitespace. Only values with a single unambiguous JSON form are allowed:
// strings, booleans, null, safe integers, arrays and plain objects.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError(`canonicalJson: ${value} is not a safe integer`);
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  // Plain data objects only: object literals / JSON.parse output, or null-prototype dictionaries.
  const proto = typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
  if (typeof value === "object" && (proto === Object.prototype || proto === null)) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  throw new TypeError(`canonicalJson: unsupported value of type ${typeof value}`);
}

const encoder = new TextEncoder();

export async function mandateHash(payload: MandatePayload): Promise<string> {
  const digest = await subtle.digest("SHA-256", encoder.encode(canonicalJson(payload)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Signature: IEEE P1363 (r‖s, 64 bytes), WebCrypto's native ECDSA format, as base64url.
export async function signMandate(payload: MandatePayload, privateKey: SigningKey): Promise<string> {
  const signature = await subtle.sign(SIGN, privateKey, encoder.encode(canonicalJson(payload)));
  return toBase64Url(new Uint8Array(signature));
}

export type VerifyResult =
  | { ok: true; mandate: VerifiedMandate; canonicalJson: string; hash: string }
  | { ok: false; reason: "malformed_payload" | "invalid_mandate" | "bad_key" | "bad_signature" };

// Never throws on bad input: every failure is a reason the caller can log and refuse.
export async function verifyMandate(args: { payload: unknown; signature: string; publicKeyJwk: PublicKeyJwk }): Promise<VerifyResult> {
  const parsed = payloadSchema.safeParse(args.payload);
  if (!parsed.success) return { ok: false, reason: "malformed_payload" };
  const payload = parsed.data;

  const checked = validateMandate({
    memberId: payload.memberId,
    maxUnitPriceCents: BigInt(payload.maxUnitPriceCents),
    qtyMin: payload.qtyMin,
    qtyMax: payload.qtyMax,
    deadlineAt: new Date(payload.deadlineAt),
  });
  if (!checked.ok) return { ok: false, reason: "invalid_mandate" };

  let key: SigningKey;
  try {
    key = await subtle.importKey("jwk", args.publicKeyJwk, ECDSA, false, ["verify"]);
  } catch {
    return { ok: false, reason: "bad_key" };
  }

  const signature = fromBase64Url(args.signature);
  const canonical = canonicalJson(payload);
  if (!signature || !(await subtle.verify(SIGN, key, signature, encoder.encode(canonical)))) {
    return { ok: false, reason: "bad_signature" };
  }
  const hash = await mandateHash(payload);
  const mandate = { ...checked.mandate, roundId: payload.roundId, hash } as VerifiedMandate;
  return { ok: true, mandate, canonicalJson: canonical, hash };
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return undefined;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}
