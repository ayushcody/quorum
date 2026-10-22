import { createHash } from "node:crypto";

// PayPal-Request-Id = UUIDv5(QUORUM_NAMESPACE, business key): a retried intent always resends the
// same id, and two different intents can never share one (ARCHITECTURE §5.3).
export const QUORUM_NAMESPACE = "5b6f2c1e-8d4a-4f3b-9c7e-2a1d0e9f8b6c";

// RFC 4122 §4.3, name-based with SHA-1.
export function uuidv5(namespace: string, name: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  if (ns.length !== 16) throw new TypeError(`not a UUID: ${namespace}`);
  const hash = createHash("sha1").update(ns).update(name, "utf8").digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function requestIdFor(businessKey: string): string {
  return uuidv5(QUORUM_NAMESPACE, businessKey);
}
