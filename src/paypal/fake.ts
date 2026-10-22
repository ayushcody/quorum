import type { OpKind } from "../outbox/kinds.ts";
import type { OpParams, PayPalPort, PortOutcome, PortRequest } from "./port.ts";

// In-memory PayPal for tests (no network). It dedupes by kind + PayPal-Request-Id like the real API,
// and can lose a response after applying the change: the case the outbox must reconcile, not resend.

export type FakeFault = "timeout_before_apply" | "timeout_after_apply" | "http_500" | "http_429" | { status: number; name: string; issues?: string[] };

type Auth = { status: string; amountCents: string; capturedCents: string; captureId?: string };
type Order = { status: string; amountCents: string; authorizationId?: string };
type Capture = { status: string; amountCents: string; authorizationId: string };

const usd = (cents: string) => ({ value: (Number(cents) / 100).toFixed(2), currencyCode: "USD" });
const timeout: PortOutcome = { ok: false, httpStatus: null, transport: "timeout", issues: [] };
const error = (status: number, name: string, issues: string[] = []): PortOutcome => ({ ok: false, httpStatus: status, transport: null, name, issues, debugId: `fake-${status}` });
const ok = (httpStatus: number, body: unknown): PortOutcome => ({ ok: true, httpStatus, body });

export class FakePayPal implements PayPalPort {
  readonly calls: PortRequest[] = [];
  private readonly faults = new Map<OpKind, FakeFault[]>();
  private readonly replies = new Map<string, PortOutcome>();
  private readonly auths = new Map<string, Auth>();
  private readonly orders = new Map<string, Order>();
  private readonly captures = new Map<string, Capture>();
  private seq = 0;

  failNext(kind: OpKind, fault: FakeFault): void {
    this.faults.set(kind, [...(this.faults.get(kind) ?? []), fault]);
  }

  seedAuthorization(a: { authorizationId: string; amountCents: string; status?: "CREATED" | "CAPTURED" | "VOIDED" }): void {
    const captured = a.status === "CAPTURED";
    this.auths.set(a.authorizationId, { status: a.status ?? "CREATED", amountCents: a.amountCents, capturedCents: captured ? a.amountCents : "0" });
  }

  authorization(id: string): Auth | undefined {
    const a = this.auths.get(id);
    return a && { ...a };
  }

  async send(req: PortRequest): Promise<PortOutcome> {
    this.calls.push(structuredClone(req));
    const dedupeKey = `${req.kind}:${req.requestId}`;
    const fault = this.faults.get(req.kind)?.shift();
    if (fault === "timeout_before_apply") return timeout;
    if (fault === "http_500") return error(500, "INTERNAL_SERVER_ERROR");
    if (fault === "http_429") return error(429, "RATE_LIMIT_REACHED");
    if (typeof fault === "object") return error(fault.status, fault.name, fault.issues);

    const previous = this.replies.get(dedupeKey);
    const outcome = previous ?? this.apply(req);
    if (outcome.ok && !previous) this.replies.set(dedupeKey, outcome);
    return fault === "timeout_after_apply" ? timeout : outcome;
  }

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  private authBody(id: string, a: Auth) {
    return { id, status: a.status, amount: usd(a.amountCents) };
  }

  private orderBody(id: string, o: Order) {
    const auth = o.authorizationId ? this.auths.get(o.authorizationId) : undefined;
    return {
      id,
      status: o.status,
      purchaseUnits: [{ payments: auth ? { authorizations: [this.authBody(o.authorizationId!, auth)] } : {} }],
    };
  }

  private apply(req: PortRequest): PortOutcome {
    switch (req.kind) {
      case "create_order": {
        const p = req.params as OpParams["create_order"];
        const orderId = this.id("ORDER");
        if (p.funding === "demo_card") {
          const authorizationId = this.id("AUTH");
          this.auths.set(authorizationId, { status: "CREATED", amountCents: p.amountCents, capturedCents: "0" });
          this.orders.set(orderId, { status: "COMPLETED", amountCents: p.amountCents, authorizationId });
          return ok(201, this.orderBody(orderId, this.orders.get(orderId)!));
        }
        this.orders.set(orderId, { status: "CREATED", amountCents: p.amountCents });
        return ok(201, { id: orderId, status: "CREATED" });
      }
      case "authorize_order": {
        const { orderId } = req.params as OpParams["authorize_order"];
        const order = this.orders.get(orderId);
        if (!order) return error(404, "RESOURCE_NOT_FOUND");
        if (order.authorizationId) return error(422, "UNPROCESSABLE_ENTITY", ["ORDER_ALREADY_AUTHORIZED"]);
        const authorizationId = this.id("AUTH");
        this.auths.set(authorizationId, { status: "CREATED", amountCents: order.amountCents, capturedCents: "0" });
        order.status = "COMPLETED";
        order.authorizationId = authorizationId;
        return ok(201, this.orderBody(orderId, order));
      }
      case "get_order": {
        const { orderId } = req.params as OpParams["get_order"];
        const order = this.orders.get(orderId);
        return order ? ok(200, this.orderBody(orderId, order)) : error(404, "RESOURCE_NOT_FOUND");
      }
      case "get_authorization": {
        const { authorizationId } = req.params as OpParams["get_authorization"];
        const auth = this.auths.get(authorizationId);
        return auth ? ok(200, this.authBody(authorizationId, auth)) : error(404, "RESOURCE_NOT_FOUND");
      }
      case "capture": {
        const { authorizationId, amountCents } = req.params as OpParams["capture"];
        const auth = this.auths.get(authorizationId);
        if (!auth) return error(404, "RESOURCE_NOT_FOUND");
        if (auth.status === "CAPTURED") return error(422, "UNPROCESSABLE_ENTITY", ["AUTHORIZATION_ALREADY_CAPTURED"]);
        if (auth.status !== "CREATED") return error(422, "UNPROCESSABLE_ENTITY", ["AUTHORIZATION_VOIDED"]);
        if (BigInt(amountCents) > BigInt(auth.amountCents)) return error(422, "UNPROCESSABLE_ENTITY", ["CAPTURE_AMOUNT_EXCEEDS_AUTHORIZED"]);
        const captureId = this.id("CAP");
        Object.assign(auth, { status: "CAPTURED", capturedCents: amountCents, captureId });
        this.captures.set(captureId, { status: "COMPLETED", amountCents, authorizationId });
        return ok(201, { id: captureId, status: "COMPLETED", amount: usd(amountCents) });
      }
      case "void": {
        const { authorizationId } = req.params as OpParams["void"];
        const auth = this.auths.get(authorizationId);
        if (!auth) return error(404, "RESOURCE_NOT_FOUND");
        if (auth.status === "CAPTURED") return error(422, "UNPROCESSABLE_ENTITY", ["AUTHORIZATION_ALREADY_CAPTURED"]);
        if (auth.status !== "CREATED") return error(422, "UNPROCESSABLE_ENTITY", ["AUTHORIZATION_VOIDED"]);
        auth.status = "VOIDED";
        return ok(200, this.authBody(authorizationId, auth));
      }
      case "reauthorize": {
        const { authorizationId, amountCents } = req.params as OpParams["reauthorize"];
        const auth = this.auths.get(authorizationId);
        if (!auth || auth.status !== "CREATED") return error(422, "UNPROCESSABLE_ENTITY", ["AUTHORIZATION_NOT_REAUTHORIZABLE"]);
        const newId = this.id("AUTH");
        this.auths.set(newId, { status: "CREATED", amountCents, capturedCents: "0" });
        return ok(201, this.authBody(newId, this.auths.get(newId)!));
      }
      case "refund": {
        const { captureId, amountCents } = req.params as OpParams["refund"];
        const capture = this.captures.get(captureId);
        if (!capture) return error(404, "RESOURCE_NOT_FOUND");
        capture.status = amountCents === capture.amountCents ? "REFUNDED" : "PARTIALLY_REFUNDED";
        return ok(201, { id: this.id("REFUND"), status: "COMPLETED", amount: usd(amountCents) });
      }
      case "get_capture": {
        const { captureId } = req.params as OpParams["get_capture"];
        const capture = this.captures.get(captureId);
        return capture ? ok(200, { id: captureId, status: capture.status, amount: usd(capture.amountCents) }) : error(404, "RESOURCE_NOT_FOUND");
      }
      default:
        return { ok: false, httpStatus: null, transport: "config", name: "UNSUPPORTED_KIND", issues: [] };
    }
  }
}
