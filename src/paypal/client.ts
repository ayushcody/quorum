// The only file that imports the APIMatic PayPal SDK (`paypal` package; boundary rule 2).
// orders.ts and payments.ts get the client and the few SDK values they need from here.
import {
  AuthError,
  CheckoutPaymentIntent,
  ConnectionError,
  DecodeError,
  OrdersCardVerificationMethod,
  PaypalClient,
  TimeoutError,
  type ApiResult,
} from "paypal";
import { SANDBOX_BASE_URL } from "../config/env.ts";
import type { PortOutcome } from "./port.ts";

export { CheckoutPaymentIntent, OrdersCardVerificationMethod };
export type { PaypalClient };

export const REPRESENTATION = "return=representation";

export function createPayPalClient(o: { clientId: string; clientSecret: string; fetch?: typeof fetch }): PaypalClient {
  const base = o.fetch ?? globalThis.fetch;
  // PayPal answers 415 to a POST with no Content-Type, and the SDK omits it when a call has no body
  // (authorizeOrder without one, voidPayment always): DECISIONS D3.
  const withJsonContentType: typeof fetch = (input, init) => {
    const request = new Request(input, init);
    if (request.method === "GET" || request.headers.has("content-type")) return base(request);
    const headers = new Headers(request.headers);
    headers.set("content-type", "application/json");
    return base(new Request(request, { headers }));
  };
  return new PaypalClient({
    fetch: withJsonContentType,
    serverOptions: { baseUrl: SANDBOX_BASE_URL },
    oauth2: { clientId: o.clientId, clientSecret: o.clientSecret },
    // The outbox owns retries: one SDK attempt per outbox attempt, so classification sees each outcome.
    retry: { maxRetries: 0 },
  });
}

type PayPalErrorModel = { name?: string; debugId?: string; details?: Array<{ issue?: string }> };

function errorModel(payload: unknown): PayPalErrorModel {
  // Typed arms nest PayPal's error under `body` (D3); an undeclared arm carries the raw bytes.
  const p = payload as { body?: PayPalErrorModel; rawBody?: ArrayBuffer };
  if (p?.body) return p.body;
  if (p?.rawBody) {
    try {
      const raw = JSON.parse(new TextDecoder().decode(p.rawBody)) as { name?: string; debug_id?: string; details?: Array<{ issue?: string }> };
      return { ...(raw.name ? { name: raw.name } : {}), ...(raw.debug_id ? { debugId: raw.debug_id } : {}), ...(raw.details ? { details: raw.details } : {}) };
    } catch {
      return {};
    }
  }
  return {};
}

// Runs one SDK call and turns whatever happens into a PortOutcome; it never throws.
export async function toPortOutcome<T>(run: () => { asApiResult(): Promise<ApiResult<T, any>> }): Promise<PortOutcome> {
  try {
    const result = await run().asApiResult();
    if (result.ok) return { ok: true, httpStatus: result.status, body: result.value };
    const e = errorModel(result.payload);
    return {
      ok: false,
      httpStatus: result.status,
      transport: null,
      ...(e.name ? { name: e.name } : {}),
      ...(e.debugId ? { debugId: e.debugId } : {}),
      issues: (e.details ?? []).flatMap((d) => (d.issue ? [d.issue] : [])),
    };
  } catch (err) {
    // A 2xx whose body didn't decode (e.g. a bare 204 from void) still means PayPal did it:
    // recording it as a failure would leave a done void looking failed.
    if (err instanceof DecodeError && err.status >= 200 && err.status < 300) return { ok: true, httpStatus: err.status, body: null };
    if (err instanceof DecodeError) return { ok: false, httpStatus: err.status, transport: null, issues: [] };
    if (err instanceof TimeoutError) return { ok: false, httpStatus: null, transport: "timeout", issues: [] };
    if (err instanceof ConnectionError) return { ok: false, httpStatus: null, transport: "network", issues: [] };
    if (err instanceof AuthError) return { ok: false, httpStatus: null, transport: "config", name: "AUTH_FAILED", issues: [] };
    // Encode errors, bugs: nothing reached PayPal, or we can't tell; treat as configuration.
    return { ok: false, httpStatus: null, transport: "config", name: (err as Error).name ?? "UNEXPECTED", issues: [] };
  }
}
