import type { OpKind } from "../outbox/kinds.ts";

// The one shape every PayPal call goes through. Money is a string of cents ("1000"). Card data is
// never a param: a demo_card order gets the card from a source injected into the orders handler.

export type OpParams = {
  create_order: { amountCents: string; customId: string; invoiceId: string; funding: "paypal_wallet" | "demo_card" };
  authorize_order: { orderId: string };
  get_order: { orderId: string };
  get_authorization: { authorizationId: string };
  get_capture: { captureId: string };
  capture: { authorizationId: string; amountCents: string };
  void: { authorizationId: string };
  reauthorize: { authorizationId: string; amountCents: string };
  refund: { captureId: string; amountCents: string };
  client_token: Record<string, never>;
  payout: { senderBatchId: string; invoiceId: string; receiver: string; amountCents: string };
  get_payout: { payoutBatchId: string };
};

export type PortRequest<K extends OpKind = OpKind> = { kind: K; requestId: string; params: OpParams[K] };

export type PortOutcome =
  | { ok: true; httpStatus: number; body: unknown }
  | {
      ok: false;
      httpStatus: number | null;
      transport: "timeout" | "network" | "config" | null;
      name?: string;
      issues: string[];
      debugId?: string;
    };

export interface PayPalPort {
  send(req: PortRequest): Promise<PortOutcome>;
}

export type Handler = (req: PortRequest) => Promise<PortOutcome>;
export type HandlerSet = Partial<Record<OpKind, Handler>>;

export const configFailure = (name: string): PortOutcome => ({ ok: false, httpStatus: null, transport: "config", name, issues: [] });

export function composePort(...handlerSets: HandlerSet[]): PayPalPort {
  const handlers: HandlerSet = Object.assign({}, ...handlerSets);
  return {
    send: (req) => handlers[req.kind]?.(req) ?? Promise.resolve(configFailure("UNSUPPORTED_KIND")),
  };
}
