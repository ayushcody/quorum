import type { ObservableWrite } from "./kinds.ts";

// Settling an ambiguous write by reading the resource it targets (ARCHITECTURE §5.4).
// Bodies are the SDK's camelCase shapes. Anything unreadable counts as "not observed".

type ReadKind = "get_authorization" | "get_order" | "get_capture";

const field = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;

export function observedDone(kind: ObservableWrite, getBody: unknown): boolean {
  const status = field(getBody, "status");
  switch (kind) {
    case "capture":
      return status === "CAPTURED" || status === "PARTIALLY_CAPTURED";
    case "void":
      return status === "VOIDED";
    case "refund":
      return status === "REFUNDED" || status === "PARTIALLY_REFUNDED";
    case "authorize_order": {
      const units = field(getBody, "purchaseUnits");
      const first = Array.isArray(units) ? units[0] : undefined;
      const authorizations = field(field(first, "payments"), "authorizations");
      return Array.isArray(authorizations) && authorizations.length > 0 && typeof field(authorizations[0], "id") === "string";
    }
  }
}

export function reconcileRead(kind: ObservableWrite, params: unknown): { kind: ReadKind; params: Record<string, string> } {
  const p = (params ?? {}) as Record<string, string>;
  switch (kind) {
    case "capture":
    case "void":
      return { kind: "get_authorization", params: { authorizationId: p.authorizationId! } };
    case "authorize_order":
      return { kind: "get_order", params: { orderId: p.orderId! } };
    case "refund":
      return { kind: "get_capture", params: { captureId: p.captureId! } };
  }
}
