import { cents, toDollars } from "../policy/money.ts";
import { REPRESENTATION, toPortOutcome, type PaypalClient } from "./client.ts";
import type { HandlerSet, OpParams, PortRequest } from "./port.ts";

// Money-moving handlers: capture, void, reauthorize, refund (plus the reads reconcile needs).
// Boundary rule 3: only src/settlement/worker.ts may import this file (CLAUDE.md).

const usd = (amountCents: string) => ({ currencyCode: "USD", value: toDollars(cents(BigInt(amountCents))) });

export function paymentsHandlers(client: PaypalClient): HandlerSet {
  return {
    capture: (req: PortRequest) => {
      const p = req.params as OpParams["capture"];
      // Always final: PayPal releases whatever is left of the hold (R1).
      return toPortOutcome(() =>
        client.payments.captureAuthorizedPayment({
          authorizationId: p.authorizationId,
          payPalRequestId: req.requestId,
          prefer: REPRESENTATION,
          body: { amount: usd(p.amountCents), finalCapture: true },
        }),
      );
    },
    void: (req: PortRequest) => {
      const p = req.params as OpParams["void"];
      return toPortOutcome(() => client.payments.voidPayment({ authorizationId: p.authorizationId, payPalRequestId: req.requestId, prefer: REPRESENTATION }));
    },
    reauthorize: (req: PortRequest) => {
      const p = req.params as OpParams["reauthorize"];
      return toPortOutcome(() =>
        client.payments.reauthorizePayment({ authorizationId: p.authorizationId, payPalRequestId: req.requestId, prefer: REPRESENTATION, body: { amount: usd(p.amountCents) } }),
      );
    },
    refund: (req: PortRequest) => {
      const p = req.params as OpParams["refund"];
      return toPortOutcome(() =>
        client.payments.refundCapturedPayment({ captureId: p.captureId, payPalRequestId: req.requestId, prefer: REPRESENTATION, body: { amount: usd(p.amountCents) } }),
      );
    },
    get_authorization: (req: PortRequest) => {
      const p = req.params as OpParams["get_authorization"];
      return toPortOutcome(() => client.payments.getAuthorizedPayment({ authorizationId: p.authorizationId }));
    },
    get_capture: (req: PortRequest) => {
      const p = req.params as OpParams["get_capture"];
      return toPortOutcome(() => client.payments.getCapturedPayment({ captureId: p.captureId }));
    },
  };
}
