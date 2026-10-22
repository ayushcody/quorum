import { verify, X509Certificate, type KeyObject } from "node:crypto";
import { crc32 } from "node:zlib";

// PayPal webhook signature check, done offline (DECISIONS D6): PayPal signs
// "<transmission_id>|<transmission_time>|<webhook_id>|<crc32(raw body)>" with SHA256withRSA and
// publishes the cert at paypal-cert-url. No PayPal API call per event, so no outbox row is needed.

// Sandbox only (CLAUDE.md). The cert URL comes from the request, so it must be pinned before any fetch.
export const CERT_URL_PREFIX = "https://api.sandbox.paypal.com/v1/notifications/certs/";

export type WebhookHeaders = {
  "paypal-transmission-id"?: string;
  "paypal-transmission-time"?: string;
  "paypal-transmission-sig"?: string;
  "paypal-cert-url"?: string;
  "paypal-auth-algo"?: string;
};

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing_headers" | "unsupported_algo" | "untrusted_cert_url" | "cert_unavailable" | "bad_signature" };

export type GetPublicKey = (certUrl: string) => Promise<KeyObject>;

export async function verifyWebhookSignature(args: {
  headers: WebhookHeaders;
  rawBody: string;
  webhookId: string;
  getPublicKey: GetPublicKey;
}): Promise<VerifyResult> {
  const h = args.headers;
  const id = h["paypal-transmission-id"];
  const time = h["paypal-transmission-time"];
  const sig = h["paypal-transmission-sig"];
  const certUrl = h["paypal-cert-url"];
  if (!id || !time || !sig || !certUrl || !h["paypal-auth-algo"]) return { ok: false, reason: "missing_headers" };
  if (h["paypal-auth-algo"] !== "SHA256withRSA") return { ok: false, reason: "unsupported_algo" };
  if (!isTrustedCertUrl(certUrl)) return { ok: false, reason: "untrusted_cert_url" };

  let key: KeyObject;
  try {
    key = await args.getPublicKey(certUrl);
  } catch {
    return { ok: false, reason: "cert_unavailable" };
  }
  const message = `${id}|${time}|${args.webhookId}|${crc32(Buffer.from(args.rawBody, "utf8"))}`;
  const valid = verify("sha256", Buffer.from(message), key, Buffer.from(sig, "base64"));
  return valid ? { ok: true } : { ok: false, reason: "bad_signature" };
}

function isTrustedCertUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.href.startsWith(CERT_URL_PREFIX) && url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

// Fetches PayPal's signing cert over HTTPS (the pinned host authenticates it), checks its validity
// window, and caches the public key per URL for the life of the process.
export function payPalCertFetcher(fetchImpl: typeof fetch = fetch, now: () => Date = () => new Date()): GetPublicKey {
  const cache = new Map<string, Promise<KeyObject>>();
  return (certUrl) => {
    let pending = cache.get(certUrl);
    if (!pending) {
      pending = (async () => {
        const res = await fetchImpl(certUrl, { signal: AbortSignal.timeout(5_000) });
        if (!res.ok) throw new Error(`cert fetch ${res.status}`);
        const cert = new X509Certificate(await res.text());
        const t = now().getTime();
        if (t < Date.parse(cert.validFrom) || t > Date.parse(cert.validTo)) throw new Error("cert outside validity window");
        return cert.publicKey;
      })();
      // A failed fetch is not cached, so the next event retries.
      pending.catch(() => cache.delete(certUrl));
      cache.set(certUrl, pending);
    }
    return pending;
  };
}
