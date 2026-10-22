import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { QUORUM_NAMESPACE, requestIdFor, uuidv5 } from "./request-id.ts";

const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DNS_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

describe("uuidv5", () => {
  it("matches the RFC 4122 known vector (DNS namespace, www.example.com)", () => {
    expect(uuidv5(DNS_NAMESPACE, "www.example.com")).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
  });
});

describe("requestIdFor", () => {
  it("is a lowercase UUIDv5 in a fixed Quorum namespace", () => {
    expect(QUORUM_NAMESPACE).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(requestIdFor("capture:AUTH-1")).toBe(uuidv5(QUORUM_NAMESPACE, "capture:AUTH-1"));
  });

  it("is deterministic and always well-formed (property)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (key) => {
        const id = requestIdFor(key);
        expect(id).toMatch(UUID_V5);
        expect(requestIdFor(key)).toBe(id);
      }),
    );
  });

  it("gives different keys different ids, so two money ops never share an idempotency key (property)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 100 }), fc.string({ maxLength: 100 }), (a, b) => {
        fc.pre(a !== b);
        expect(requestIdFor(a)).not.toBe(requestIdFor(b));
      }),
    );
  });
});
