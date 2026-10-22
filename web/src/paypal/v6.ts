// PayPal JS SDK v6, loaded from PayPal's CDN (sandbox). One-time payments use createInstance({ clientId })
// (PayPal's recommended setup; a client token is only needed for Fastlane). The server creates the
// AUTHORIZE order; the SDK only collects the buyer's approval.

type SessionOptions = { onApprove: (data: { orderId: string }) => Promise<void> | void; onCancel?: () => void; onError?: (error: unknown) => void };
type OneTimeSession = { start(options: { presentationMode: "auto" | "popup" | "modal" | "redirect" }, order: Promise<{ orderId: string }>): Promise<void> };
type SdkInstance = {
  findEligibleMethods(options: { currencyCode: string }): Promise<{ isEligible(method: "paypal"): boolean }>;
  createPayPalOneTimePaymentSession(options: SessionOptions): Promise<OneTimeSession>;
};
type PayPalNamespace = { createInstance(options: { clientId: string; components: string[]; pageType?: string }): Promise<SdkInstance> };

declare global {
  interface Window {
    paypal?: PayPalNamespace;
  }
}

let loading: Promise<PayPalNamespace> | undefined;

function loadScript(src: string): Promise<PayPalNamespace> {
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => (window.paypal ? resolve(window.paypal) : reject(new Error("PayPal SDK loaded without window.paypal")));
    script.onerror = () => reject(new Error("PayPal SDK failed to load"));
    document.head.append(script);
  });
  return loading;
}

export async function createPayPalSession(config: { paypalClientId: string; paypalSdkUrl: string }, handlers: SessionOptions): Promise<OneTimeSession | null> {
  const paypal = await loadScript(config.paypalSdkUrl);
  const sdk = await paypal.createInstance({ clientId: config.paypalClientId, components: ["paypal-payments"], pageType: "checkout" });
  const eligibility = await sdk.findEligibleMethods({ currencyCode: "USD" });
  if (!eligibility.isEligible("paypal")) return null;
  return sdk.createPayPalOneTimePaymentSession(handlers);
}
