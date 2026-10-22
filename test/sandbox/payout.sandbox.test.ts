import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadCoordinatorEnv, parseEnv } from "../../src/config/env.ts";
import { createPayout, getPayoutBatch, getToken, payoutOutcome } from "../../spikes/r4-payout/payout.ts";

// S1.5: Payouts is required (DECISIONS D1, PLAN S2.9). Prove the co-op sandbox account can pay the
// supplier before D7. Raw REST: Payouts is not in the APIMatic SDK.

describe("S1.5: co-op → supplier sandbox payout", () => {
  const env = loadCoordinatorEnv();
  const { SUPPLIER_SANDBOX_EMAIL } = parseEnv(z.object({ SUPPLIER_SANDBOX_EMAIL: z.email() }), process.env);

  it("pays $1.00 to the supplier and the item reaches SUCCESS", { timeout: 120_000 }, async () => {
    const token = await getToken(env);
    const batchId = `quorum-s15-${Date.now()}`;
    const requestId = randomUUID();
    const created = await createPayout(token, { batchId, invoiceId: `S15-${batchId}`, receiver: SUPPLIER_SANDBOX_EMAIL, amountCents: 100 }, requestId);
    console.log("create payout:", created.status, JSON.stringify(created.body));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const payoutBatchId = (created.body as { batch_header: { payout_batch_id: string } }).batch_header.payout_batch_id;

    // Same PayPal-Request-Id again: PayPal should return the same batch, not pay twice.
    const replay = await createPayout(token, { batchId, invoiceId: `S15-${batchId}`, receiver: SUPPLIER_SANDBOX_EMAIL, amountCents: 100 }, requestId);
    console.log("replay same request id:", replay.status, JSON.stringify((replay.body as { batch_header?: unknown }).batch_header ?? replay.body));

    let batch: Awaited<ReturnType<typeof getPayoutBatch>> | undefined;
    for (let i = 0; i < 20; i++) {
      batch = await getPayoutBatch(token, payoutBatchId);
      if (payoutOutcome(batch.body) !== "pending") break;
      await new Promise((r) => setTimeout(r, 3_000));
    }
    const body = batch!.body as { batch_header: { batch_status: string }; items?: Array<{ payout_item_id?: string; transaction_status?: string; transaction_id?: string; errors?: unknown }> };
    const item = body.items?.[0];
    const summary = {
      payoutBatchId,
      batchStatus: body.batch_header.batch_status,
      payoutItemId: item?.payout_item_id,
      transactionStatus: item?.transaction_status,
      transactionId: item?.transaction_id,
      itemErrors: item?.errors,
      replayStatus: replay.status,
      replayBatchId: (replay.body as { batch_header?: { payout_batch_id?: string } }).batch_header?.payout_batch_id,
    };
    console.log("final:", JSON.stringify(summary, null, 2));
    writeFileSync("spikes/r4-payout/results.json", `${JSON.stringify({ at: new Date().toISOString(), ...summary }, null, 2)}\n`);
    expect(payoutOutcome(body)).toBe("success");
  });
});
