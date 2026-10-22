import { describe, expect, it } from "vitest";
import { EnvError, loadCoordinatorEnv, SANDBOX_BASE_URL } from "./env.ts";

const valid = {
  PAYPAL_ENV: "sandbox",
  PAYPAL_CLIENT_ID: "client-id-123",
  PAYPAL_CLIENT_SECRET: "super-secret-value",
};

describe("loadCoordinatorEnv", () => {
  it("accepts a sandbox config and defaults the base URL", () => {
    const env = loadCoordinatorEnv(valid);
    expect(env.PAYPAL_BASE_URL).toBe(SANDBOX_BASE_URL);
    expect(env.PAYPAL_CLIENT_ID).toBe("client-id-123");
  });

  it("refuses to boot against the live PayPal API", () => {
    expect(() => loadCoordinatorEnv({ ...valid, PAYPAL_BASE_URL: "https://api-m.paypal.com" })).toThrow(EnvError);
  });

  it("refuses any PAYPAL_ENV other than sandbox", () => {
    expect(() => loadCoordinatorEnv({ ...valid, PAYPAL_ENV: "live" })).toThrow(/PAYPAL_ENV/);
  });

  it("names missing keys without echoing secret values", () => {
    try {
      loadCoordinatorEnv({ ...valid, PAYPAL_CLIENT_ID: "", PAYPAL_BASE_URL: "https://api-m.paypal.com" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EnvError);
      const message = (err as Error).message;
      expect(message).toMatch(/PAYPAL_CLIENT_ID/);
      expect(message).not.toContain("super-secret-value");
    }
  });
});
