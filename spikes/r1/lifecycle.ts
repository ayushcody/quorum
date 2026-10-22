import { randomUUID } from "node:crypto";
import { CheckoutPaymentIntent, OrdersCardVerificationMethod, type ApiResult, type PaypalClient } from "paypal";
import type { R1Env } from "./clients.ts";

// R1: AUTHORIZE with third-party payee → partial capture / void / reauthorize. Every write
// carries an explicit PayPal-Request-Id; the SDK's own per-call Idempotency-Key does not span calls.

const REPRESENTATION = "return=representation";

export type Failure = { ok: false; status: number; name?: string; issues: string[]; debugId?: string };
export type Outcome<T> = { ok: true; status: number; value: T } | Failure;

function toOutcome<T>(result: ApiResult<T, any>): Outcome<T> {
  if (result.ok) return { ok: true, status: result.status, value: result.value };
  const payload = result.payload as {
    name?: string;
    debugId?: string;
    details?: Array<{ issue?: string }>;
  };
  return {
    ok: false,
    status: result.status,
    ...(payload.name ? { name: payload.name } : {}),
    ...(payload.debugId ? { debugId: payload.debugId } : {}),
    issues: (payload.details ?? []).flatMap((d) => (d.issue ? [d.issue] : [])),
  };
}

export const cents = (n: number) => (n / 100).toFixed(2);

export type Funding = { kind: "card"; env: R1Env } | { kind: "wallet" };

export type CreateArgs = {
  amountCents: number;
  payeeMerchantId?: string;
  customId: string;
  invoiceId: string;
  funding: Funding;
  requestId?: string;
};

export async function createAuthorizeOrder(client: PaypalClient, args: CreateArgs) {
  const paymentSource =
    args.funding.kind === "card"
      ? {
          card: {
            name: "Quorum Bot",
            number: args.funding.env.SANDBOX_CARD_NUMBER,
            expiry: args.funding.env.SANDBOX_CARD_EXPIRY,
            securityCode: args.funding.env.SANDBOX_CARD_CVV,
            attributes: { verification: { method: OrdersCardVerificationMethod.ScaWhenRequired } },
          },
        }
      : {
          paypal: {
            experienceContext: { returnUrl: "https://example.com/return", cancelUrl: "https://example.com/cancel" },
          },
        };
  const result = await client.orders
    .createOrder({
      payPalRequestId: args.requestId ?? randomUUID(),
      prefer: REPRESENTATION,
      body: {
        intent: CheckoutPaymentIntent.Authorize,
        purchaseUnits: [
          {
            amount: { currencyCode: "USD", value: cents(args.amountCents) },
            ...(args.payeeMerchantId ? { payee: { merchantId: args.payeeMerchantId } } : {}),
            customId: args.customId,
            invoiceId: args.invoiceId,
          },
        ],
        paymentSource,
      },
    })
    .asApiResult();
  return toOutcome(result);
}

export async function authorizeOrder(client: PaypalClient, orderId: string, requestId = randomUUID()) {
  return toOutcome(
    await client.orders.authorizeOrder({ id: orderId, payPalRequestId: requestId, prefer: REPRESENTATION }).asApiResult(),
  );
}

export async function getOrder(client: PaypalClient, orderId: string) {
  return toOutcome(await client.orders.getOrder({ id: orderId }).asApiResult());
}

export async function getAuthorization(client: PaypalClient, authorizationId: string) {
  return toOutcome(await client.payments.getAuthorizedPayment({ authorizationId }).asApiResult());
}

export async function getCapture(client: PaypalClient, captureId: string) {
  return toOutcome(await client.payments.getCapturedPayment({ captureId }).asApiResult());
}

export async function capturePartial(
  client: PaypalClient,
  authorizationId: string,
  amountCents: number,
  requestId = randomUUID(),
) {
  return toOutcome(
    await client.payments
      .captureAuthorizedPayment({
        authorizationId,
        payPalRequestId: requestId,
        prefer: REPRESENTATION,
        body: { amount: { currencyCode: "USD", value: cents(amountCents) }, finalCapture: true },
      })
      .asApiResult(),
  );
}

export async function voidAuthorization(client: PaypalClient, authorizationId: string, requestId = randomUUID()) {
  return toOutcome(
    await client.payments
      .voidPayment({ authorizationId, payPalRequestId: requestId, prefer: REPRESENTATION })
      .asApiResult(),
  );
}

export async function reauthorize(client: PaypalClient, authorizationId: string, amountCents: number, requestId = randomUUID()) {
  return toOutcome(
    await client.payments
      .reauthorizePayment({
        authorizationId,
        payPalRequestId: requestId,
        prefer: REPRESENTATION,
        body: { amount: { currencyCode: "USD", value: cents(amountCents) } },
      })
      .asApiResult(),
  );
}

// The authorization created with the order (card funding) or by authorizeOrder (wallet funding).
export function firstAuthorization(order: {
  purchaseUnits?: Array<{ payments?: { authorizations?: Array<{ id?: string; status?: string; expirationTime?: string }> } }>;
}) {
  return order.purchaseUnits?.[0]?.payments?.authorizations?.[0];
}

export function approveLink(order: { links?: Array<{ rel: string; href: string }> }): string | undefined {
  return order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
}
