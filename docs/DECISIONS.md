# Quorum — Decisions

Phase 1 decision gate (docs/PLAN.md). Each decision cites the evidence in `docs/BUILD-LOG.md`.

## D1 · PAYEE_MODE = `coop_merchant` (2026-10-22)

**Context.** R1 asked whether one Merchant REST app can create AUTHORIZE orders with the supplier as third-party `payee`, then capture, void and reauthorize those authorizations. Void-all on a failed round is half the core mechanic.

**Evidence** (scripts/spike-authorize.ts, all sandbox accounts US, wallet funding, buyer `sb-oiimk53492986@personal`):

| Step | `direct` (payee = supplier `3LWC92SWYWEU6`) | `coop_merchant` (no payee; co-op `S5GTBBLLP82E2`) |
|---|---|---|
| create + buyer approve + authorize | ✅ auth `8KM65588451733341` CREATED | ✅ auth `6H38101305077141J` CREATED |
| partial capture $6.00 of $10.00, `final_capture` | ✅ `2CJ39299YJ466631P` COMPLETED → auth CAPTURED | ✅ `5LA82449F80020224` COMPLETED → auth CAPTURED |
| void | ❌ 403 `NOT_AUTHORIZED` / `PERMISSION_DENIED` (debug_id f595801def316) | ✅ `9WH953265U931150D` VOIDED |
| reauthorize inside honor period | not run (stopped at the void) | ❌ 422 `REAUTHORIZATION_TOO_SOON` (debug_id f6698665359b9), then voided |

**Decision.** Orders carry **no `payee`**. The co-op's sandbox business account is the merchant of record. Our app owns capture, void and reauthorize for every authorization. After a round settles, the co-op pays the supplier.

**Consequences**
- **S2.9 (Payouts to supplier) is now required**, not conditional. It is one outbox op `payout:{roundId}`, executed by `settlement/worker.ts` after `settled`. Payouts is not in the APIMatic SDK, so it is a raw call through `paypalCall`. The co-op sandbox account must have Payouts enabled; verify on S2.9's first run.
- The supplier's invoice is addressed to the co-op and marked paid against the payout. The coordinator still never calls Invoicing itself.
- The `payee.merchant_id` check in the policy preflight changes to "authorization payee = co-op merchant id".
- README is honest about it: "the co-op is merchant of record and pays the supplier on settlement". Funds sit with the co-op between settle and payout; we make that window short and visible in the cockpit.
- `SUPPLIER_SANDBOX_EMAIL` / `SUPPLIER_MERCHANT_ID` become the **payout receiver**, not an order field.
- `PAYEE_MODE=direct` stays in the spike script only. Production code supports just `coop_merchant`.
- **Revisit only as stretch (needs explicit "go"):** a Platform app with the supplier onboarded through partner referrals might permit void on a third-party payee's authorization. That is untested.

## D2 · Reauthorize only after the honor period (2026-10-22)

**Evidence.** Reauthorizing a fresh authorization returned 422 `REAUTHORIZATION_TOO_SOON` (D1 table).

**Decision.** Policy may plan `Reauth` only when `now > honor_ends_at` (created + 72 h) and the authorization is still inside PayPal's validity window. The fallback is therefore "past the honor period, reauthorize, then capture the new id", not a pre-emptive reauth. Rounds are still designed to close inside 72 h.

**Follow-up.** Exercise a successful reauthorize live: hold one sandbox authorization open from Day 1 and reauthorize it on Day 4 or later (during S2.7). The SDK's `reauthorizePayment` has no `PayPal-Mock-Response` field, so negative-testing it needs a raw call.

## D3 · SDK transport fix (2026-10-22)

**Evidence.** `authorizeOrder` with no body returned HTTP 415. The SDK omits `Content-Type` on body-less POSTs, and `voidPayment` never has a body.

**Decision.** `src/paypal/client.ts` builds the client with a `ClientOptions.fetch` wrapper that sets `Content-Type: application/json` on every non-GET request (see `spikes/r1/clients.ts`). Error handling reads PayPal's error model from `payload.body` on typed error arms.

## Pending gate items

| Item | Status |
|---|---|
| Bot authorization mode (R2, S1.2) | pending |
| AG Studio + Bryntum layout (R3, S1.3) | pending |
| Supplier DB role on Render (S1.4) | pending |
