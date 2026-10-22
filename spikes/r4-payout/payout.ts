import { SANDBOX_BASE_URL, type CoordinatorEnv } from "../../src/config/env.ts";

// S1.5 spike: one co-op → supplier Payout over raw REST (Payouts is not in the APIMatic SDK).
// Production moves this behind paypalCall + the `payout:{roundId}` outbox op (PLAN S2.9).

type Json = Record<string, unknown>;

export function buildPayoutRequest(args: { batchId: string; invoiceId: string; receiver: string; amountCents: number }) {
  if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) throw new Error("amountCents must be a positive integer");
  return {
    sender_batch_header: {
      sender_batch_id: args.batchId,
      email_subject: "Quorum co-op payment",
      email_message: `Payment for invoice ${args.invoiceId}`,
    },
    items: [
      {
        recipient_type: "EMAIL",
        receiver: args.receiver,
        amount: { value: (args.amountCents / 100).toFixed(2), currency: "USD" },
        // The supplier's invoice id: ties the payout to the invoice it pays (ARCHITECTURE §3.4).
        sender_item_id: args.invoiceId,
        note: `Quorum co-op payment for invoice ${args.invoiceId}`,
      },
    ],
  };
}

// Success means the *item* succeeded; a batch can be SUCCESS with an UNCLAIMED item.
export function payoutOutcome(batch: unknown): "pending" | "success" | "failed" {
  const b = batch as { batch_header?: { batch_status?: string }; items?: Array<{ transaction_status?: string }> };
  const batchStatus = b.batch_header?.batch_status;
  if (batchStatus === "DENIED" || batchStatus === "CANCELED") return "failed";
  const item = b.items?.[0]?.transaction_status;
  if (!item || item === "PENDING" || item === "ONHOLD" || batchStatus === "PENDING" || batchStatus === "PROCESSING") return "pending";
  return item === "SUCCESS" ? "success" : "failed";
}

export async function getToken(env: CoordinatorEnv): Promise<string> {
  const res = await fetch(`${SANDBOX_BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`token ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function call(token: string, method: "GET" | "POST", path: string, body?: Json, requestId?: string) {
  const res = await fetch(`${SANDBOX_BASE_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(requestId ? { "paypal-request-id": requestId } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, debugId: res.headers.get("paypal-debug-id"), body: text ? (JSON.parse(text) as unknown) : null };
}

export function createPayout(token: string, args: Parameters<typeof buildPayoutRequest>[0], requestId: string) {
  return call(token, "POST", "/v1/payments/payouts", buildPayoutRequest(args), requestId);
}

export function getPayoutBatch(token: string, payoutBatchId: string) {
  return call(token, "GET", `/v1/payments/payouts/${encodeURIComponent(payoutBatchId)}`);
}
