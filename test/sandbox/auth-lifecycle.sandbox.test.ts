import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { buildClients, loadR1Env } from "../../spikes/r1/clients.ts";
import { loadSandboxCard } from "../../spikes/r2/card.ts";
import {
  capturePartial,
  createAuthorizeOrder,
  firstAuthorization,
  getAuthorization,
  getCapture,
  reauthorize,
  voidAuthorization,
  type Outcome,
} from "../../spikes/r1/lifecycle.ts";

// R1 spike (docs/PLAN.md S1.1). Live PayPal sandbox. Findings → spikes/r1/results.json → BUILD-LOG.
// Missing credentials fail the run loudly (EnvError names the keys); see scripts/sandbox-accounts.md.

const findings: Record<string, unknown> = {};
const record = (key: string, outcome: Outcome<unknown> | unknown) => {
  findings[key] = outcome;
};

const AUTH_CENTS = 1000;
const CAPTURE_CENTS = 600;

describe("R1: authorization lifecycle", () => {
  const env = loadR1Env();
  const { coop, supplier } = buildClients(env);
  const funding = { kind: "card" as const, card: loadSandboxCard(env) };
  const mandateHash = createHash("sha256").update(`r1-${Date.now()}`).digest("hex");

  afterAll(() => {
    writeFileSync("spikes/r1/results.json", `${JSON.stringify({ at: new Date().toISOString(), findings }, null, 2)}\n`);
  });

  const authorize = async (label: string, payeeMerchantId?: string) => {
    const created = await createAuthorizeOrder(coop, {
      amountCents: AUTH_CENTS,
      ...(payeeMerchantId ? { payeeMerchantId } : {}),
      customId: mandateHash,
      invoiceId: `r1-${label}-${randomUUID().slice(0, 8)}`,
      funding,
    });
    record(`${label}.create`, created);
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) throw new Error("unreachable");
    const auth = firstAuthorization(created.value);
    expect(auth?.id, "card-funded AUTHORIZE order should carry an authorization").toBeTruthy();
    return { order: created.value, authorizationId: auth!.id! };
  };

  for (const mode of ["direct", "coop_merchant"] as const) {
    describe(`payee mode: ${mode}`, () => {
      const payee = mode === "direct" ? env.SUPPLIER_MERCHANT_ID : undefined;

      it("creates an AUTHORIZE order with a live authorization bound to the mandate hash", async () => {
        const { authorizationId } = await authorize(`${mode}.basic`, payee);
        const auth = await getAuthorization(coop, authorizationId);
        record(`${mode}.basic.getAuthorization`, auth);
        expect(auth.ok).toBe(true);
        if (!auth.ok) return;
        expect(auth.value.status).toBe("CREATED");
        expect(auth.value.customId).toBe(mandateHash);
        if (payee) expect(auth.value.payee?.merchantId).toBe(payee);
      });

      it("partially captures with final_capture and the remainder is released", async () => {
        const { authorizationId } = await authorize(`${mode}.capture`, payee);
        const capture = await capturePartial(coop, authorizationId, CAPTURE_CENTS);
        record(`${mode}.capture.capture`, capture);
        expect(capture.ok, JSON.stringify(capture)).toBe(true);
        if (!capture.ok) return;
        expect(["COMPLETED", "PENDING"]).toContain(capture.value.status);
        expect(capture.value.amount?.value).toBe("6.00");

        const after = await getAuthorization(coop, authorizationId);
        record(`${mode}.capture.authorizationAfter`, after);
        expect(after.ok && after.value.status).toBe("CAPTURED");

        // Where did the money land? The supplier's own credentials can read only its own captures.
        const seenBySupplier = await getCapture(supplier, capture.value.id!);
        record(`${mode}.capture.seenBySupplier`, seenBySupplier);
        expect(seenBySupplier.ok).toBe(mode === "direct");
      });

      it("voids an authorization", async () => {
        const { authorizationId } = await authorize(`${mode}.void`, payee);
        const voided = await voidAuthorization(coop, authorizationId);
        record(`${mode}.void.void`, voided);
        expect(voided.ok, JSON.stringify(voided)).toBe(true);
        const after = await getAuthorization(coop, authorizationId);
        record(`${mode}.void.authorizationAfter`, after);
        expect(after.ok && after.value.status).toBe("VOIDED");
      });

      it("records what reauthorize does inside the honor period", async () => {
        const { authorizationId } = await authorize(`${mode}.reauth`, payee);
        const reauth = await reauthorize(coop, authorizationId, AUTH_CENTS);
        record(`${mode}.reauth.reauthorize`, reauth);
        // Either outcome is a finding; we only require PayPal to say which.
        expect(reauth.ok || Boolean(reauth.name)).toBe(true);
        if (reauth.ok) {
          expect(reauth.value.id).not.toBe(authorizationId);
          const voided = await voidAuthorization(coop, reauth.value.id!);
          record(`${mode}.reauth.voidNew`, voided);
        } else {
          record(`${mode}.reauth.voidOld`, await voidAuthorization(coop, authorizationId));
        }
      });
    });
  }

  describe("PayPal-Request-Id", () => {
    it("dedupes a repeated createOrder", async () => {
      const requestId = randomUUID();
      const args = {
        amountCents: AUTH_CENTS,
        payeeMerchantId: env.SUPPLIER_MERCHANT_ID,
        customId: mandateHash,
        invoiceId: `r1-dedupe-${requestId.slice(0, 8)}`,
        funding,
        requestId,
      };
      const first = await createAuthorizeOrder(coop, args);
      const second = await createAuthorizeOrder(coop, args);
      record("dedupe.createOrder", { first, second });
      expect(first.ok && second.ok).toBe(true);
      if (first.ok && second.ok) expect(second.value.id).toBe(first.value.id);
    });

    it("dedupes a repeated capture", async () => {
      const { authorizationId } = await authorize("dedupe.capture", env.SUPPLIER_MERCHANT_ID);
      const requestId = randomUUID();
      const first = await capturePartial(coop, authorizationId, CAPTURE_CENTS, requestId);
      const second = await capturePartial(coop, authorizationId, CAPTURE_CENTS, requestId);
      record("dedupe.capture", { first, second });
      expect(first.ok && second.ok).toBe(true);
      if (first.ok && second.ok) expect(second.value.id).toBe(first.value.id);
    });
  });
});
