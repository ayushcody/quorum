import { appendFileSync } from "node:fs";
import { z } from "zod";
import { loadCoordinatorEnv, parseEnv } from "../src/config/env.ts";
import { sandboxClient } from "../spikes/r1/clients.ts";
import {
  approveLink,
  authorizeOrder,
  capturePartial,
  createAuthorizeOrder,
  firstAuthorization,
  getAuthorization,
  getOrder,
  reauthorize,
  voidAuthorization,
  type Failure,
  type Outcome,
} from "../spikes/r1/lifecycle.ts";
import { formatBuildLogEntry, isPayeeRejection, type StepRecord } from "../spikes/r1/report.ts";

// Spike 1 (R1), wallet-funded: three AUTHORIZE orders approved by a sandbox buyer, then
// A: partial capture, B: void, C: reauthorize. Stops on any payee rejection.
// PAYEE_MODE=direct sets payee = SUPPLIER_SANDBOX_EMAIL; coop_merchant (default, decided 2026-10-22,
// docs/DECISIONS.md) sends no payee, so the co-op app's own account is the merchant.
// Run: pnpm spike:authorize   (or PAYEE_MODE=direct pnpm spike:authorize)

const env = loadCoordinatorEnv();
const { PAYEE_MODE: payeeMode } = parseEnv(
  z.object({ PAYEE_MODE: z.enum(["direct", "coop_merchant"]).default("coop_merchant") }),
  process.env,
);
const supplierEmail =
  payeeMode === "direct"
    ? parseEnv(z.object({ SUPPLIER_SANDBOX_EMAIL: z.email() }), process.env).SUPPLIER_SANDBOX_EMAIL
    : undefined;
const coop = sandboxClient(env.PAYPAL_CLIENT_ID, env.PAYPAL_CLIENT_SECRET);

const AUTH_CENTS = 1000;
const CAPTURE_CENTS = 600;
const APPROVAL_TIMEOUT_MS = 30 * 60_000;
const steps: StepRecord[] = [];

function finish(stoppedReason?: string): never {
  const date = new Date().toISOString().slice(0, 10);
  appendFileSync("docs/BUILD-LOG.md", formatBuildLogEntry({ date, payeeMode, steps, ...(stoppedReason ? { stoppedReason } : {}) }));
  console.log(`\n${stoppedReason ? `STOPPED: ${stoppedReason}` : "Done"}. Appended results to docs/BUILD-LOG.md.`);
  process.exit(stoppedReason ? 1 : 0);
}

// Records and prints the step; stops the run if PayPal refused the payee, or if `required` and it failed.
function step<T extends { id?: string; status?: string }>(label: string, call: string, outcome: Outcome<T>, required = true): T | undefined {
  const record: StepRecord = outcome.ok
    ? { label, call, ok: true, ...pick(outcome.value) }
    : { label, call, ok: false, status: String(outcome.status), issues: outcome.issues, ...failureFields(outcome) };
  steps.push(record);
  console.log(outcome.ok ? `${label} ${call} → id=${record.id} status=${record.status}` : `${label} ${call} → FAILED ${JSON.stringify(outcome)}`);
  if (!outcome.ok && isPayeeRejection(outcome)) finish(`third-party payee rejected at ${label}.${call}`);
  if (!outcome.ok && required) finish(`${label}.${call} failed`);
  return outcome.ok ? outcome.value : undefined;
}

const pick = (v: { id?: string; status?: string }) => ({ ...(v.id ? { id: v.id } : {}), ...(v.status ? { status: v.status } : {}) });
const failureFields = (f: Failure) => ({ ...(f.name ? { name: f.name } : {}), ...(f.debugId ? { debugId: f.debugId } : {}) });

// 1. Create three orders, or resume already-created ones: --resume=A:<orderId>,B:<orderId>,C:<orderId>
const labels = ["A", "B", "C"] as const;
const orders: Record<string, { id: string }> = {};
const resumeArg = process.argv.find((arg) => arg.startsWith("--resume="));
for (const pair of resumeArg?.slice("--resume=".length).split(",") ?? []) {
  const [label, id] = pair.split(":");
  if (label && id) orders[label] = { id };
}
if (resumeArg && labels.some((label) => !orders[label])) finish("--resume needs A, B and C order ids");
for (const label of resumeArg ? [] : labels) {
  const order = step(
    label,
    "createOrder",
    await createAuthorizeOrder(coop, {
      amountCents: AUTH_CENTS,
      ...(supplierEmail ? { payeeEmail: supplierEmail } : {}),
      customId: `spike-authorize-${label}`,
      invoiceId: `spike-authorize-${label}-${Date.now()}`,
      funding: { kind: "wallet" },
    }),
  )!;
  const payee = order.purchaseUnits?.[0]?.payee;
  console.log(`${label} payee as PayPal recorded it: ${JSON.stringify(payee)}`);
  orders[label] = { id: order.id! };
  console.log(`${label} approve as the sandbox buyer: ${approveLink(order)}\n`);
}

// 2. Wait for the buyer to approve all three (polls GET order; no keypress needed).
console.log("Waiting for all three approvals…");
const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
const pending = new Set<string>(labels);
while (pending.size > 0) {
  if (Date.now() > deadline) finish(`approval timed out for ${[...pending].join(", ")}`);
  for (const label of [...pending]) {
    const order = await getOrder(coop, orders[label]!.id);
    if (order.ok && order.value.status === "APPROVED") {
      pending.delete(label);
      console.log(`${label} getOrder → id=${order.value.id} status=APPROVED`);
    }
  }
  if (pending.size > 0) await new Promise((r) => setTimeout(r, 3_000));
}

// 3. Authorize each; confirm which merchant the authorization belongs to.
const authorizationIds: Record<string, string> = {};
for (const label of labels) {
  const authorized = step(label, "authorizeOrder", await authorizeOrder(coop, orders[label]!.id))!;
  const auth = firstAuthorization(authorized);
  if (!auth?.id) finish(`${label}.authorizeOrder returned no authorization`);
  step(label, "authorization", { ok: true, status: 201, value: { id: auth.id, ...(auth.status ? { status: auth.status } : {}) } });
  const detail = step(label, "getAuthorizedPayment", await getAuthorization(coop, auth.id))!;
  console.log(`${label} authorization payee: ${JSON.stringify(detail.payee)} expires=${detail.expirationTime}`);
  authorizationIds[label] = auth.id;
}

// 4. A: partial capture 6.00 of 10.00, final.
step("A", "captureAuthorizedPayment", await capturePartial(coop, authorizationIds.A!, CAPTURE_CENTS));
step("A", "getAuthorizedPayment(after)", await getAuthorization(coop, authorizationIds.A!));

// 5. B: void.
step("B", "voidPayment", await voidAuthorization(coop, authorizationIds.B!));
step("B", "getAuthorizedPayment(after)", await getAuthorization(coop, authorizationIds.B!));

// 6. C: reauthorize inside the honor period. A refusal here is a finding, not a stop.
const reauth = step("C", "reauthorizePayment", await reauthorize(coop, authorizationIds.C!, AUTH_CENTS), false);
const toRelease = reauth?.id ?? authorizationIds.C!;
step("C", "voidPayment(cleanup)", await voidAuthorization(coop, toRelease), false);

finish();
