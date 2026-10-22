import { describe, expect, it } from "vitest";
import { buildPayoutRequest, payoutOutcome } from "../../spikes/r4-payout/payout.ts";

describe("buildPayoutRequest", () => {
  it("pays one email receiver in USD, keyed by the invoice id", () => {
    const body = buildPayoutRequest({ batchId: "round-1", invoiceId: "INV2-AAAA", receiver: "sb-supplier@business.example.com", amountCents: 100 });
    expect(body).toEqual({
      sender_batch_header: { sender_batch_id: "round-1", email_subject: "Quorum co-op payment", email_message: "Payment for invoice INV2-AAAA" },
      items: [
        {
          recipient_type: "EMAIL",
          receiver: "sb-supplier@business.example.com",
          amount: { value: "1.00", currency: "USD" },
          sender_item_id: "INV2-AAAA",
          note: "Quorum co-op payment for invoice INV2-AAAA",
        },
      ],
    });
  });

  it("refuses non-integer or non-positive cents", () => {
    for (const amountCents of [0, -100, 1.5]) {
      expect(() => buildPayoutRequest({ batchId: "b", invoiceId: "i", receiver: "r@x.y", amountCents })).toThrow(/amountCents/);
    }
  });
});

describe("payoutOutcome", () => {
  it("is pending until the batch and the item are terminal", () => {
    expect(payoutOutcome({ batch_header: { batch_status: "PENDING" }, items: [] })).toBe("pending");
    expect(payoutOutcome({ batch_header: { batch_status: "PROCESSING" }, items: [{ transaction_status: "PENDING" }] })).toBe("pending");
  });

  it("is success only when the item itself succeeded", () => {
    expect(payoutOutcome({ batch_header: { batch_status: "SUCCESS" }, items: [{ transaction_status: "SUCCESS" }] })).toBe("success");
    expect(payoutOutcome({ batch_header: { batch_status: "SUCCESS" }, items: [{ transaction_status: "UNCLAIMED" }] })).toBe("failed");
    expect(payoutOutcome({ batch_header: { batch_status: "DENIED" }, items: [] })).toBe("failed");
  });
});
