import { describe, expect, it } from "vitest";
import { loadSandboxCard, normalizeExpiry } from "./card.ts";

describe("normalizeExpiry", () => {
  it("accepts PayPal's YYYY-MM as is", () => {
    expect(normalizeExpiry("2030-07")).toBe("2030-07");
  });

  it("converts the card generator's MM/YYYY to YYYY-MM", () => {
    expect(normalizeExpiry("07/2030")).toBe("2030-07");
  });

  it("rejects anything else", () => {
    for (const bad of ["7/2030", "07/30", "2030/07", "13/2030", "00/2030", "2030-13", ""]) {
      expect(normalizeExpiry(bad), bad).toBeUndefined();
    }
  });
});

describe("loadSandboxCard", () => {
  const env = { SANDBOX_CARD_NUMBER: "4000000000000000", SANDBOX_CARD_EXPIRY: "07/2030", SANDBOX_CARD_CVV: "123" };

  it("returns a card with a PayPal-format expiry", () => {
    expect(loadSandboxCard(env)).toEqual({ number: "4000000000000000", expiry: "2030-07", securityCode: "123" });
  });

  it("names the bad key without echoing the card number", () => {
    try {
      loadSandboxCard({ ...env, SANDBOX_CARD_EXPIRY: "July 2030" });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(/SANDBOX_CARD_EXPIRY/);
      expect((err as Error).message).not.toContain("4000000000000000");
    }
  });
});
