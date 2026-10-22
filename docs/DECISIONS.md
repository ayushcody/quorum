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

**Follow-up.** Exercise a successful reauthorize live. R2 left bot-3's card authorization `82C58801S8168605E` open for this (created 2026-10-22T10:51:04Z, honor period ends 2026-10-25T10:51Z, expires 2026-11-20). Reauthorize it on Day 4 or later, during S2.7. The SDK's `reauthorizePayment` has no `PayPal-Mock-Response` field, so negative-testing it needs a raw call.

## D3 · SDK transport fix (2026-10-22)

**Evidence.** `authorizeOrder` with no body returned HTTP 415. The SDK omits `Content-Type` on body-less POSTs, and `voidPayment` never has a body.

**Decision.** `src/paypal/client.ts` builds the client with a `ClientOptions.fetch` wrapper that sets `Content-Type: application/json` on every non-GET request (see `spikes/r1/clients.ts`). Error handling reads PayPal's error model from `payload.body` on typed error arms.

## D4 · Bot members authorize with sandbox cards, in demo mode only (2026-10-22)

**Context.** R2 asked whether seeded "bot" members can authorize with no buyer approval step, so a judge can run a full round with zero setup.

**Evidence** (`test/sandbox/bot-authorize.sandbox.test.ts`, co-op app with ACDC enabled, generated US Visa, `PAYEE_MODE=coop_merchant`):

| Bot | Order (one createOrder call) | Authorization | Next step |
|---|---|---|---|
| bot-1 | `4G023762PE2323331` COMPLETED | `7SG08247AR6349919` CREATED | captured $6.00 of $10.00, final → `61P384428C347241W` COMPLETED; authorization CAPTURED |
| bot-2 | `5A543397VM668010C` COMPLETED | `8XL4147766030574P` CREATED | voided → VOIDED |
| bot-3 | `5MH158086G011021F` COMPLETED | `82C58801S8168605E` CREATED | left open for the D2 reauth follow-up |

**Decision.**
- In **demo mode only** (judge mode, `seed:demo`, smoke tests), bot members authorize server-side with `payment_source.card`, intent AUTHORIZE, no payee (D1), and `custom_id` = mandate hash, all in one `createOrder` call.
- **The human pledge path stays PayPal-button based (JS SDK v6):** create order → buyer approves in the PayPal popup → `authorizeOrder`. Real members never type card numbers into Quorum.
- Card data comes only from the `SANDBOX_CARD_*` env vars (PayPal's published sandbox test cards). Card fields are never logged.
- A non-demo round must refuse the card path. The pledge service enforces this with an `is_demo` check on the round, tested in S2.5.

**ACDC quirks found**
- **Single step:** a card-funded AUTHORIZE order comes back `COMPLETED` with the authorization inline. There is no approval step and no `authorizeOrder` call. The bot code path therefore never calls `authorizeOrder`.
- **No 3DS** challenge was triggered with `verification.method = SCA_WHEN_REQUIRED` for the generated US Visa.
- **Expiry format:** the card generator shows `MM/YYYY`, but PayPal requires `YYYY-MM`. `spikes/r2/card.ts` normalizes it.
- `processor_response` is absent on the sandbox authorization, and seller protection is `NOT_ELIGIBLE`, so neither can be relied on in the UI.
- The authorization lifetime matches wallet authorizations: created + 29 days. The capture showed a $0.65 sandbox PayPal fee on $6.00, so the cockpit should show net amounts if it shows fees at all.

## D5 · AG Studio and Bryntum Scheduler Pro share one React 19 + Vite app (2026-10-22)

**Evidence.** The `/spike` route (`web/src/spike/SpikePage.tsx`, run with `pnpm dev`) renders one AG Studio grid widget over a `pledges` source, plus a Bryntum Scheduler Pro timeline. The timeline has four lanes and a payment-gated dependency chain: pledge window and negotiation → quorum reached → capture → delivery. It was checked in the browser at the pane size and at 1400×900. A production `vite build` also succeeds.

**Exact versions** (pinned exactly in package.json):

| Package | Version | Notes |
|---|---|---|
| `react`, `react-dom` | 19.2.8 | same as the PayPal × AG Grid boilerplate; 19.3.1 exists but is untested here |
| `ag-studio`, `ag-studio-react` | 3.0.0 | must be identical (AG Studio install docs) |
| ↳ `ag-grid-enterprise` / `ag-grid-community` | 36.2.0 | transitive, via `ag-studio` (`~36.2.0`) |
| ↳ `ag-charts-enterprise` / `ag-charts-community` | 14.2.0 | transitive, via `ag-studio` (`~14.2.0`) |
| `@bryntum/schedulerpro` | `npm:@bryntum/schedulerpro-trial@7.3.7` | public trial, installed under the licensed name by npm alias |
| `@bryntum/schedulerpro-react` | 7.3.7 | React wrapper; requires React ≥ 18 and Vite ≥ 5 |
| `vite` / `@vitejs/plugin-react` | 8.3.5 / 6.1.2 | `root: web`, `envDir: ..` (reads the project-root .env) |
| `@types/react` / `@types/react-dom` | 19.2.8 / 19.2.3 | |

**Licences: how each product reads them**
- **AG Studio**: runtime key, `AgStudioProvider licenseKey`, read from `VITE_AG_STUDIO_LICENSE_KEY` by `readLicenses()`. Without a key all features work, but Studio logs a "License Key Not Found" block at **console.error** level and shows a watermark. **The spike's console is error-free only once that key is set.** VITE_ variables are bundled into browser JS. That is expected for AG Studio keys, which ship client-side, but never put another secret under a VITE_ name.
- **Bryntum**: there is **no runtime licence key**. The trial-vs-licensed switch is the npm package, so nothing is read from env. The trial package shows a watermark and logs one info line ("Bryntum SchedulerPro 7.3.7 Trial"). To use the licensed build, run `npm login` to `npm.bryntum.com` with Bryntum Customer Zone credentials (the user does this; credentials are never put in the repo). Then change the alias to `"@bryntum/schedulerpro": "7.3.7"` from that registry. No application code changes.

**Integration notes**
- Bryntum needs three CSS imports (structural `schedulerpro.css`, exactly one theme such as `svalbard-light.css`, and FontAwesome's `fontawesome.css` + `solid.css`), plus a parent with a definite height. A CSS grid with `minmax(300px, 1fr)` rows keeps it from collapsing to its min-height, which otherwise triggers a console warning.
- Bryntum data goes in `<BryntumSchedulerProProjectModel ref>` and the scheduler gets `project={ref}`. Inline store config on `project` triggers a dev warning.
- AG Studio needs no CSS import (it is themed from JS) and a sized parent. Keep `data` and `initialState` stable (`useState`/`useMemo`). `enableStudioDevValidations()` is guarded with `import.meta.env.DEV`, not `process.env`.
- The two trial install scripts (`@bryntum/schedulerpro-trial`, `@bryntum/schedulerpro-trial-lib`) were read before approval in `pnpm.onlyBuiltDependencies`. They use only `fs`/`path`, with no network access, and stamp an install UUID into the trial's own JS files.
- The bundle is about 10 MB (3.3 MB gzipped), mostly these two libraries. Code-split per route before deploy (S5.3/S5.4).

**Still unproven from R3**: the Studio Agent Framework hookup (a custom agent that talks to Studio's built-in agents). AG Studio's AI runs through `AgStudioAiModule` plus a model adapter, and the boilerplate's adapter is OpenAI-specific. Quorum is Claude-only, so S4.4 needs an Anthropic adapter behind a server proxy. That is S4.4's risk to retire first.

## Pending gate items

| Item | Status |
|---|---|
| Bot authorization mode (R2, S1.2) | **decided: D4** |
| AG Studio + Bryntum layout (R3, S1.3) | **decided: D5** (one app, one route; Agent Framework still unproven) |
| Supplier DB role on Render (S1.4) | pending |
