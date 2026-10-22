import type { Db } from "../db/client.ts";
import { classify } from "../outbox/errors.ts";
import { isObservableWrite } from "../outbox/kinds.ts";
import { observedDone, reconcileRead } from "../outbox/reconcile.ts";
import { claimOne, completeOp, enqueueOp, type EnqueueArgs, type OpRow } from "../outbox/repo.ts";
import type { PayPalPort, PortOutcome, PortRequest } from "./port.ts";

// The only code that calls port.send (CLAUDE.md: an outbox row is committed before every PayPal
// call, and its request_id is the PayPal-Request-Id). Inline request handlers and the settlement
// worker both come through here.

export type CallDeps = { db: Db; port: PayPalPort; now: () => Date };
export const MAX_ATTEMPTS = 8;

export function backoffMs(attempts: number): number {
  return Math.min(300_000, 1_000 * 2 ** Math.max(0, attempts - 1));
}

async function send(deps: CallDeps, op: OpRow): Promise<PortOutcome> {
  const req = { kind: op.kind, requestId: op.requestId, params: op.request } as PortRequest;
  try {
    return await deps.port.send(req);
  } catch {
    // A port must not throw; if one does, nothing is known about whether PayPal saw the call.
    return { ok: false, httpStatus: null, transport: "network", issues: [] };
  }
}

// Execute a row this process has claimed (in_flight).
export async function paypalCall(deps: CallDeps, op: OpRow): Promise<OpRow> {
  const outcome = await send(deps, op);
  const failure = outcome.ok ? undefined : outcome;
  const errorFields = { httpStatus: outcome.httpStatus, errorName: failure?.name ?? null, debugId: failure?.debugId ?? null };

  switch (classify(op.kind, outcome)) {
    case "succeeded":
      return completeOp(deps.db, op.id, { status: "succeeded", httpStatus: outcome.httpStatus, response: outcome.ok ? (outcome.body ?? null) : null });
    case "retry_later":
      if (op.attempts >= MAX_ATTEMPTS) return completeOp(deps.db, op.id, { status: "failed_terminal", ...errorFields });
      return completeOp(deps.db, op.id, { status: "pending", ...errorFields, nextAttemptAt: new Date(deps.now().getTime() + backoffMs(op.attempts)) });
    case "check_then_retry":
    case "check_then_terminal":
      // http_status records the cause: null / 5xx → a resend is safe if not done; 4xx → PayPal refused.
      return completeOp(deps.db, op.id, { status: "unknown", ...errorFields });
    case "terminal":
      return completeOp(deps.db, op.id, { status: "failed_terminal", ...errorFields });
  }
}

// For request handlers that need the answer now. A row that already succeeded is returned as is, with
// no second call; a row someone else holds, or that isn't due, is returned unchanged.
export async function runInline(deps: CallDeps, args: EnqueueArgs): Promise<OpRow> {
  const row = await enqueueOp(deps.db, args);
  if (row.status === "succeeded") return row;
  const claimed = await claimOne(deps.db, row.id, deps.now());
  if (!claimed) return row;
  return paypalCall(deps, claimed);
}

// Settle an `unknown` row. Observable writes are checked with a GET, itself an outbox row, so the
// rule holds for reads too. If the write took effect, it succeeded; if not, a timeout/5xx cause goes
// back to pending (the same request id resends safely), and a 4xx cause is terminal.
export async function reconcileOp(deps: CallDeps, op: OpRow): Promise<OpRow> {
  if (op.status !== "unknown") return op;
  const retryOrGiveUp = () =>
    op.attempts >= MAX_ATTEMPTS
      ? completeOp(deps.db, op.id, { status: "failed_terminal" })
      : completeOp(deps.db, op.id, { status: "pending", nextAttemptAt: new Date(deps.now().getTime() + backoffMs(op.attempts)) });

  if (!isObservableWrite(op.kind)) return retryOrGiveUp();

  const read = reconcileRead(op.kind, op.request);
  const readRow = await runInline(deps, {
    businessKey: `get:${op.kind}:${op.businessKey}:${op.attempts}`,
    kind: read.kind,
    mode: "inline",
    request: read.params,
    ...(op.roundId ? { roundId: op.roundId } : {}),
    ...(op.pledgeId ? { pledgeId: op.pledgeId } : {}),
  });
  // The GET itself didn't answer: stay unknown, and the reconcile sweep tries again later.
  if (readRow.status !== "succeeded") return op;

  if (observedDone(op.kind, readRow.response)) return completeOp(deps.db, op.id, { status: "succeeded", response: readRow.response });
  const refused = op.httpStatus !== null && op.httpStatus < 500;
  return refused ? completeOp(deps.db, op.id, { status: "failed_terminal" }) : retryOrGiveUp();
}
