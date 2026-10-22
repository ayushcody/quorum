import type { PortOutcome } from "../paypal/port.ts";
import { isObservableWrite, type OpKind } from "./kinds.ts";

// What an outcome means for the outbox (ARCHITECTURE §5.4). The rule that matters: an ambiguous
// outcome on a write a GET can confirm is never blindly resent; the GET decides.
export type Classification = "succeeded" | "retry_later" | "check_then_retry" | "check_then_terminal" | "terminal";

const PAYOUT_DUPLICATE = /sender_batch_id already exists/i;

export function classify(kind: OpKind, outcome: PortOutcome): Classification {
  if (outcome.ok) return "succeeded";
  if (outcome.transport === "config") return "terminal";
  const status = outcome.httpStatus;
  if (status === 401 || status === 403 || status === 415) return "terminal";
  // Payouts dedupe on sender_batch_id, not PayPal-Request-Id (S1.5): "already exists" means it was paid.
  if (kind === "payout" && status === 400 && outcome.name === "USER_BUSINESS_ERROR" && outcome.issues.some((i) => PAYOUT_DUPLICATE.test(i))) {
    return "succeeded";
  }
  const transient = outcome.transport === "timeout" || outcome.transport === "network" || (status !== null && status >= 500);
  if (transient) return isObservableWrite(kind) ? "check_then_retry" : "retry_later";
  if (status === 429) return "retry_later";
  if ((status === 409 || status === 422) && isObservableWrite(kind)) return "check_then_terminal";
  return "terminal";
}
