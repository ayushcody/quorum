import { toDollars, cents } from "../policy/money.ts";
import { CheckoutPaymentIntent, OrdersCardVerificationMethod, REPRESENTATION, toPortOutcome, type PaypalClient } from "./client.ts";
import { configFailure, type HandlerSet, type OpParams, type PortRequest } from "./port.ts";

// Order-side handlers: create (AUTHORIZE, no payee: DECISIONS D1), authorize, read.
// The pledge service may use these; capture/void/reauth live in payments.ts.

export type CardSource = () => { number: string; expiry: string; securityCode: string };

const usd = (amountCents: string) => ({ currencyCode: "USD", value: toDollars(cents(BigInt(amountCents))) });

export function ordersHandlers(client: PaypalClient, opts: { cardSource?: CardSource }): HandlerSet {
  return {
    create_order: async (req: PortRequest) => {
      const p = req.params as OpParams["create_order"];
      if (p.funding === "demo_card" && !opts.cardSource) return configFailure("DEMO_CARD_UNCONFIGURED");
      // Demo bots only (D4): the card comes from the injected source at send time, never from the op row.
      let card: ReturnType<CardSource> | undefined;
      try {
        card = p.funding === "demo_card" ? opts.cardSource!() : undefined;
      } catch {
        return configFailure("DEMO_CARD_UNCONFIGURED");
      }
      return toPortOutcome(() =>
        client.orders.createOrder({
          payPalRequestId: req.requestId,
          prefer: REPRESENTATION,
          body: {
            intent: CheckoutPaymentIntent.Authorize,
            purchaseUnits: [{ amount: usd(p.amountCents), customId: p.customId, invoiceId: p.invoiceId }],
            ...(card
              ? {
                  paymentSource: {
                    card: {
                      name: "Quorum demo member",
                      number: card.number,
                      expiry: card.expiry,
                      securityCode: card.securityCode,
                      attributes: { verification: { method: OrdersCardVerificationMethod.ScaWhenRequired } },
                    },
                  },
                }
              : {}),
          },
        }),
      );
    },
    authorize_order: (req: PortRequest) => {
      const { orderId } = req.params as OpParams["authorize_order"];
      return toPortOutcome(() => client.orders.authorizeOrder({ id: orderId, payPalRequestId: req.requestId, prefer: REPRESENTATION }));
    },
    get_order: (req: PortRequest) => {
      const { orderId } = req.params as OpParams["get_order"];
      return toPortOutcome(() => client.orders.getOrder({ id: orderId }));
    },
  };
}
