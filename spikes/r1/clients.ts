import { PaypalClient } from "paypal";
import { z } from "zod";
import { parseEnv, SANDBOX_BASE_URL } from "../../src/config/env.ts";
import { normalizeExpiry } from "../r2/card.ts";

// R1 spike only. Production client construction moves to src/paypal/client.ts in S2.4.
// Two REST apps: the co-op (our coordinator) and the supplier (used here only to check where money landed).

const nonEmpty = z.string().trim().min(1);

export const r1EnvSchema = z.object({
  PAYPAL_ENV: z.literal("sandbox"),
  PAYPAL_CLIENT_ID: nonEmpty,
  PAYPAL_CLIENT_SECRET: nonEmpty,
  SUPPLIER_MERCHANT_ID: nonEmpty,
  SUPPLIER_PAYPAL_CLIENT_ID: nonEmpty,
  SUPPLIER_PAYPAL_CLIENT_SECRET: nonEmpty,
  // PayPal's sandbox card generator (developer dashboard → Testing tools). Test values only.
  SANDBOX_CARD_NUMBER: nonEmpty,
  SANDBOX_CARD_EXPIRY: z.string().refine((v) => normalizeExpiry(v) !== undefined),
  SANDBOX_CARD_CVV: z.string().regex(/^\d{3,4}$/),
});

export type R1Env = z.infer<typeof r1EnvSchema>;

export function loadR1Env(source: Record<string, string | undefined> = process.env): R1Env {
  return parseEnv(r1EnvSchema, source);
}

// PayPal answers 415 to a POST with no Content-Type, and the SDK omits the header when a call has no
// body (authorizeOrder without one, voidPayment always). `fetch` is the SDK's only transport seam.
const withJsonContentType: typeof fetch = (input, init) => {
  const request = new Request(input, init);
  if (request.method === "GET" || request.headers.has("content-type")) return fetch(request);
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  return fetch(new Request(request, { headers }));
};

export function sandboxClient(clientId: string, clientSecret: string): PaypalClient {
  return new PaypalClient({
    fetch: withJsonContentType,
    serverOptions: { baseUrl: SANDBOX_BASE_URL },
    oauth2: { clientId, clientSecret },
  });
}

export function buildClients(env: R1Env) {
  return {
    coop: sandboxClient(env.PAYPAL_CLIENT_ID, env.PAYPAL_CLIENT_SECRET),
    supplier: sandboxClient(env.SUPPLIER_PAYPAL_CLIENT_ID, env.SUPPLIER_PAYPAL_CLIENT_SECRET),
  };
}
