# Quorum — Build Plan (22 days, solo)

Window: **Day 1 = Thu Oct 22 → Day 22 = Thu Nov 12 (deadline 12:00 PST)**. Submit on **Day 20 (Tue Nov 10)**.
Design reference: `docs/ARCHITECTURE.md`. Product intent: `docs/STRATEGY.md`.

**Current phase: Phase 2 — Payment backbone** (Phase 1 closed 2026-10-22, on D1 instead of D3; see "Phase 1 close-out" below). Build only slices in the current phase. Advance this line only when the phase's exit criteria are met. The ~2 days gained are banked as buffer in Phase 6, not spent on new scope.

## Ground rules (from CLAUDE.md, applied to every slice)

- A slice is ≤ 1 day: **AM** ≈ half day, **PM** ≈ half day, **D** = full day. Each slice ends with `pnpm test && pnpm typecheck` green.
- Write the failing test first. The "Proving test" column names that test.
- A slice that touches PayPal or the APIMatic SDK ends with 3 lines appended to `docs/BUILD-LOG.md` (what, prompt, outcome). These slices are tagged 🅿.
- **Demo-visible?** means it appears in the video or in judge mode. "No" slices are still required.
- Test tiers: `pnpm test` (unit, property, integration against a local Postgres, and a fake PayPal port; no network). `pnpm test:sandbox` (live PayPal sandbox, opt-in). `pnpm test:llm` (live Claude evals, opt-in). The two opt-in scripts are added in S1.0.
- Each new dependency's reason goes in its commit message (see ARCHITECTURE §8).
- Run `pnpm db:up` (Docker Postgres 17, `quorum-pg`) before `pnpm test`. From S2.1 on, DB-backed integration tests are part of `pnpm test`, so DB code never runs for the first time on Render.
- **A slice's proving test must state a money or safety invariant.** Config plumbing gets at most one test. Spike-only tests are deleted when the spike code is retired (end of Phase 2).

## Top 3 riskiest assumptions → Phase 1 spikes

| # | Assumption | Why it could sink us | Spike | Fallback if false |
|---|---|---|---|---|
| **R1** | One sandbox REST app can create `AUTHORIZE` orders with a **third-party `payee`** (the supplier's sandbox business account), then **partially capture** (`final_capture`), **void**, and **reauthorize** those authorizations | This is the core mechanic. If third-party capture needs permissions we can't get, money flows to the wrong account. If reauth can't be exercised, the fallback path is untested | S1.1 | `PAYEE_MODE=coop_merchant`: the co-op is the merchant and pays the supplier via Payouts (adds slice S2.9). For reauth, exercise the path through sandbox negative-testing mocks and say so in the README |
| **R2** | **Bot members can authorize server-side** with `payment_source.card` (sandbox test cards) and get an authorization **without a buyer approval step**. This works alongside one human JS SDK v6 approval in the same round | Judge mode, the video, and "judges may never run your code" all depend on a full round happening with zero setup | S1.2 | Bots use pre-approved sandbox buyer logins driven once at seed time, and judge mode replays seeded **authorized** pledges into a fresh round. The judge's own pledge stays live |
| **R3** | **AG Studio + Studio Agent Framework + Bryntum Scheduler Pro** run together in one React 19 + Vite app. We can ship a custom widget fed by our API, and a custom agent that talks to Studio's built-in agents | This is the primary sponsor prize ($5k/$2k/$1k×3). Its API surface is unfamiliar, and a framework conflict found in Phase 4 would be fatal | S1.3 | Host AG Studio and Bryntum on separate routes or iframes if they conflict. If the Agent Framework can't call our tools, the custom agent reads a precomputed read-model endpoint instead |

Lesser risks we accept without a dedicated spike, with mitigations elsewhere: webhook delivery to Render (covered in S1.4), Render allowing a second Postgres role (S1.4, fallback is schema plus import test), JS SDK v6 client-token flow (S1.2), LLM cost under judge traffic (S5.2), Channel3 quota/latency (S3.8, cached plus fixture fallback).

---

## Phase 1 — Risky spikes (Days 1–3, Oct 22–24)

Spike code lives in `spikes/` and is throwaway. Its value is the sandbox test and the BUILD-LOG entry. `spikes/` is typechecked but exempt from the boundary rules: the boundary test scans `src/`, `web/` and `scripts/` only.

| ID | When | Slice | Files to create | Proving test | Demo-visible? |
|---|---|---|---|---|---|
| S1.0 | D1 AM | Repo skeleton: `git init`, pnpm, TS strict, Vitest, env loader with a sandbox-only guard, boundary-test harness, test scripts | `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/config/env.ts`, `test/arch/boundaries.test.ts`, `.env.example` (keys only) | `env.test.ts`: boot throws if the PayPal base URL ≠ sandbox. `boundaries.test.ts` fails on a fixture file that violates rule 2 | No |
| S1.1 🅿 | D1 PM → D2 AM | **R1**: script sandbox accounts (1 co-op business, 1 supplier business, 4 personal). Install the APIMatic Context Plugin. Run AUTHORIZE + third-party payee → partial capture → void → reauthorize. Record behavior and error names | `scripts/sandbox-accounts.md` (manual steps where the dashboard is required), `spikes/r1-auth-lifecycle.ts`, `test/sandbox/auth-lifecycle.sandbox.test.ts` | Sandbox test asserts: (a) capture of 60% with `final_capture` → COMPLETED and lands in the **supplier's** account, (b) void → VOIDED, (c) reauth result recorded (success, or the exact error name plus a mock-header run), (d) a repeat call with the same `PayPal-Request-Id` returns the same resource | No |
| S1.2 🅿 | D2 PM | **R2**: card-funded bot authorization with no approval step. Minimal v6 button page that mints a client token, approves, and authorizes. Both kinds in one "round" | `spikes/r2-bots.ts`, `spikes/r2-v6.html`, `test/sandbox/bot-authorize.sandbox.test.ts` | Sandbox test: 3 card-funded orders with `intent=AUTHORIZE` each return an authorization in CREATED with `custom_id` intact. Manual checklist in BUILD-LOG: one v6 approval authorized | No |
| S1.3 | D3 AM | **R3**: Vite + React 19 app with AG Studio from the sponsor boilerplate plus Bryntum Scheduler Pro on one route. One custom widget fed by a JSON endpoint. A custom agent registered with the Studio Agent Framework answers one question and invokes one built-in agent | `spikes/r3-studio/` (vite app), `spikes/r3-studio/NOTES.md` (API surface found) | `vite build` passes with both libs. A Vitest test renders the custom widget's data mapper. Manual: agent answers "how many pledges?" from the endpoint | No |
| S1.4 🅿 | D3 PM | **Built 2026-10-22; deploy pending (done by the user in the Render dashboard).** Blueprint `render.yaml` (web + worker + Postgres), `GET /health` (200/503 on DB), `POST /webhooks/paypal` (offline signature check, DECISIONS D6), every env var in `.env.example` (`test/env-docs.test.ts`). Original scope: deploy a hello Hono app to Render (web + Postgres). Register the sandbox webhook. Receive and verify `PAYMENT.AUTHORIZATION.CREATED` from S1.2. Try creating the `supplier` DB role. **Decision gate** | `src/api/app.ts` (hello + `/webhooks/paypal` log-only), `render.yaml`, `docs/DECISIONS.md` | A Render-hosted event shows up in the logs with `verify-webhook-signature` = SUCCESS. `DECISIONS.md` records PAYEE_MODE, bot mode, Studio layout, DB role | No |

**Exit criteria / decision gate (end of D3):** R1–R3 each marked confirmed or fallback chosen in `docs/DECISIONS.md`. ARCHITECTURE §3.5 updated with verified facts. If more than one fallback is triggered, cut a stretch item and re-sequence Phase 2 before starting it.

## Phase 1 close-out (2026-10-22)

**Phase 1 carry-overs.** Each item is something Phase 1 didn't prove, with an owner and a slice:

| Item | Owner | When | Done when |
|---|---|---|---|
| First Render deploy (Blueprint), live `/health` with `db: ok`, webhook created, `PAYPAL_WEBHOOK_ID` set | user (dashboard steps from S1.4) | before S2.8 | a real sandbox event logs `paypal_webhook` with `verified: true` (D6) |
| JS SDK v6 popup approval → `authorizeOrder` (no client token needed: v6 recommends `createInstance({ clientId })` for one-time payments) | S2.5 + user | D6 AM | **page built 2026-10-22**: v6 button renders and sandbox SDK loads cleanly; a real approval through `/round/:id` is **not yet confirmed** (the first attempt never reached the API) |
| A **successful** reauthorize | S2.7 | on/after 2026-10-25T10:51Z | `82C58801S8168605E` (bot-3) reauthorizes; the new id captures or voids |
| `PayPal-Request-Id` dedupe on Orders/Payments writes, live | S2.4 | D5 PM | **done 2026-10-22**: same capture id `4VS924551F678250D` for both sends; authorization captured once |
| Studio Agent Framework hookup | S4.4, first task | D14 | Anthropic adapter behind a server proxy answers in Studio |

Closed in Phase 1 with no carry-over: payee mode (D1), reauth timing (D2), SDK quirks (D3), bot cards (D4), Studio + Bryntum coexistence (D5), webhook verification design (D6), Payouts enabled on the co-op account (S1.5, D1), supplier DB isolation design (D7).

## Phase 2 — Payment backbone (Days 4–7, Oct 25–28)

**How Phase 2 runs**
- **Model per slice** (pick it in the app's model picker before starting the slice; `/clear` between slices):
  - **Opus**: S2.2 (`src/policy/`), S2.7 (`src/settlement/worker.ts`), S2.9 (`src/settlement/payout.ts`). Suggested also for S2.4 (outbox + idempotency).
  - **Sonnet**: S2.1 (DB), S2.3, S2.5 (routes), S2.6 (webhooks), S2.8.
- **test-writer first on the Opus slices**: the `test-writer` subagent writes the failing tests and shows the red run, then the Opus session implements until green.
- **Gate before the Day 7 Render deploy**: run the `policy-reviewer` subagent on the whole Phase 2 diff (Phase 1 tip..HEAD). Fix every blocker and major finding before S2.8 deploys. Record minors in BUILD-LOG.
- **Deploy prompt (S2.8)**, verbatim: "Create render.yaml with web + worker + Postgres, health endpoint, and document env vars in .env.example."

| ID | When | Slice | Files to create | Proving test | Demo-visible? |
|---|---|---|---|---|---|
| S2.1 | D4 AM | Data model + migrations + base seed | `src/db/schema.ts`, `src/db/client.ts`, `src/db/migrations/*`, `drizzle.config.ts`, `scripts/seed-demo.ts` (members, one round) | `test/integration/schema.test.ts` (against `pnpm db:up`): migrate an empty DB; duplicate `paypal_ops.business_key` rejected; `captured_cents > amount_cents` rejected; `UNIQUE(round_id, member_id)` on mandates; `pledges.funding` only `paypal_wallet`/`demo_card`; round states include `invoiced`, `paid_out` | No |
| S2.2 | D4 PM | Policy kernel v1: money, mandate validation, clearing, allocate, `evaluateRound`, state machines | `src/policy/{money,mandate,clearing,allocate,settlement,state,index}.ts` + `*.test.ts` | fast-check invariants 1–7 and 10 (ARCHITECTURE §6). Example tests: no-quorum → Abort; low-ceiling member released while quorum holds | No |
| S2.3 | D5 AM | Mandate canonicalization + ECDSA P-256 sign/verify; `VerifiedMandate` brand | `src/pledge/mandate-sign.ts`, `src/pledge/mandate-sign.test.ts` | Tampering with any field → verify fails. Key order doesn't change the hash. `VerifiedMandate` can't be built outside the module (type test with `@ts-expect-error`) | No |
| S2.4 🅿 | D5 PM | PayPal wrapper + outbox: `paypalCall`, UUIDv5 request ids, claim/complete, error classifier, fake port. **Reuse the spike code:** `withJsonContentType` (`spikes/r1/clients.ts`) becomes `client.ts`'s fetch, and `toOutcome`'s `payload.body` read (`spikes/r1/lifecycle.ts`) becomes `outbox/errors.ts`. Webhook verification is not here (it's `src/webhooks/verify.ts`, D6) | `src/paypal/{client,call,orders,payments,port,fake}.ts`, `src/outbox/{repo,request-id,errors,reconcile}.ts` + tests, `test/sandbox/request-id.sandbox.test.ts` | Same business key twice → 1 row, 1 port call. Crash after insert → retry reuses the request id. Timeout → `unknown` → reconcile GET → `succeeded`. A stubbed `fetch` sees `Content-Type: application/json` on body-less POSTs (DECISIONS D3), and errors are read from `payload.body`. `errors.ts` maps Payouts' 400 "sender_batch_id already exists" to already-done → reconcile (S1.5). Sandbox: one capture sent twice with the same Request-Id gives one capture id (carry-over). Boundary rules 2–3 pass | No |
| S2.5 🅿 | D6 AM | **First:** JS SDK v6 client token + one human popup approval (carry-over). Then the pledge flow: create-order and authorize routes, v6 button on `/round/:id` (bare UI, code-split route), and the bot path in seed. Bots use a single-step card `createOrder` with no `authorizeOrder` (from `spikes/r2/bots.ts`); `spikes/r2/card.ts` moves to `src/pledge/card.ts` | `src/pledge/{service,routes}.ts`, `web/index.html`, `web/src/main.tsx`, `web/src/routes/Round.tsx`, `web/src/paypal/v6.ts`, `vite.config.ts` | `test/integration/pledge.test.ts` (fake port): pledge → order_created → authorized, with the mandate hash in `custom_id`. `pledge.sandbox.test.ts`: a bot pledge authorizes live. The card path is refused for a round with `is_demo = false` (DECISIONS D4). **Bundle check** (`scripts/check-bundle.ts` reads Vite's manifest): the `/round/:id` chunk graph contains neither `ag-studio*` nor `@bryntum/*` | **Yes** (member approves on PayPal) |
| S2.6 🅿 | D6 PM | Webhook inbox. Signature verification and the route already exist (S1.4, D6); this adds the `webhook_events` insert, dedupe, reconcile, `evaluateRound` and audit, plus the `PAYMENT.PAYOUTS-ITEM.*` events | `src/webhooks/handlers.ts` + tests, `src/api/app.ts` (wire handler), `test/fixtures/webhooks/*.json` | Same event twice → one transition. Bad signature → stored with `verified=false`, not processed. AUTHORIZATION.CREATED for an already-authorized pledge → no-op | Yes (webhook log in cockpit later) |
| S2.7 🅿 | D7 AM | Settlement worker: preflight, capture-all, void-all, reauth-before-settle, unwind (refund + void), tick loop | `src/settlement/{worker,planner}.ts`, `src/worker/main.ts` + tests | Fake-port scenarios: happy path; one capture fails after 2 succeed → Unwind refunds 2, voids rest; past `honor_ends_at` → reauth then capture the new id (inside the honor period: no reauth planned, per DECISIONS D2); worker killed mid-batch → restart, no duplicate capture. Boundary rule 3. **Live (carry-over):** reauthorize bot-3's `82C58801S8168605E` after 2026-10-25T10:51Z and record the result in DECISIONS D2 | **Yes** (captures and voids) |
| S2.8 🅿 | D8 AM | **After the policy-reviewer gate and the user's first deploy (carry-over).** `render.yaml`, `/health` and env docs already exist (S1.4); what's left: the Phase 2 code deployed, fixed-price round end-to-end on Render (no negotiation yet), a plain audit page | `src/api/{cockpit,sse}.ts`, `web/src/routes/Audit.tsx`, `scripts/smoke.ts` | `pnpm smoke --target=$RENDER_URL --scenario=fixed`: 3 bots + quorum → `settled` and captures visible via GET. `--scenario=no-quorum` → `voided` | **Yes** |
| S2.9 🅿 | D7 PM. **Required (D1).** S3.1 + S3.2 share D8 PM. S4.6 is **not** cut: S2.8 shrank because S1.4 pulled render.yaml, /health and env docs forward | Pay the supplier's invoice with one Payout (ARCHITECTURE §3.4): on `invoice_issued`, check amount == captured total → round `invoiced` → `payout:{roundId}` op (`sender_batch_id` = op key, `sender_item_id` = invoice id) → `PAYMENT.PAYOUTS-ITEM.SUCCEEDED` → `paid_out` → `payout_sent` to the supplier. Raw call via `paypalCall`; reuse `spikes/r4-payout/payout.ts`. The supplier side (issue invoice, record payment) is a stub until S3.7 | `src/settlement/payout.ts`, `src/policy/settlement.ts` (payout rule), tests | Fake port: exactly one payout op per round, even when `invoice_issued` is replayed; amount mismatch → terminal, no payout; Payouts' 400 "already exists" → reconcile, not retry. Sandbox: payout reaches SUCCESS (already proven once in S1.5) | Yes |

**Exit:** a real sandbox round settles and a no-quorum round voids, both on Render, driven by `scripts/smoke.ts`. All Phase 1 carry-overs due in Phase 2 are done.

## Phase 3 — Agents (Days 8–11, Oct 29–Nov 1)

**How Phase 3 runs**
- **The negotiator follows the OG-Narrator split** (ARCHITECTURE §4). The concession schedule, the coalition limit L and the accept rule are pure functions in `src/policy/`. The LLM only writes messages and classifies the supplier's intent (`final_offer | counter | stall | other`). Neither can change a price.
- **Model per slice** (pick it in the model picker; `/clear` between slices):
  - **Opus** designs and builds the negotiator: S3.1 (concession + accept), S3.3 (orchestrator), S3.4 (both narrators and the public-facts prompt builder), S3.5 (injection resistance). The test-writer subagent writes the failing tests first on S3.1 and S3.5.
  - **Sonnet**: S3.2 (supplier service), S3.6 (intake agent), S3.7 (supplier fulfillment), S3.8 (Channel3 client).
- **Red-team daily from D9 PM**, once S3.3 and S3.4 exist. Before that, the agent only reports "not built yet". Run the `injection-redteam` subagent at the end of each day and fix every FAIL before the next slice. Record each run's score in BUILD-LOG.

| ID | When | Slice | Files to create | Proving test | Demo-visible? |
|---|---|---|---|---|---|
| S3.1 | D8 AM | Concession engine + accept rule; coalition limit re-computed as pledges change | `src/policy/{concession,accept}.ts` + tests | fast-check: bid monotone, `≤ L`, accepts only `p ≤ L`. Walks at k=N if `p > L`. Adding a pledge never lowers L (invariant 8 + L monotonicity) | No |
| S3.2 | D8 PM | Supplier service skeleton: own entrypoint, env, DB schema, HMAC protocol, deterministic strategy (no LLM yet) | `src/protocol/{messages,hmac}.ts`, `src/supplier/{main,env,db,strategy}.ts` + tests, Render service in `render.yaml` | Contract test: signed offer → counter. Bad HMAC → 401. Replayed nonce → 409. Boundary rule 6 | No |
| S3.3 | D9 AM | Negotiation orchestrator in the worker: ticks, turns, re-quote on quantity change, accept → lock → settle | `src/negotiation/{orchestrator,supplier-client}.ts` + tests | Integration with a stub narrator and an in-process supplier: given seed pledges and a supplier floor, it converges in ≤ 6 turns to the expected price. A new pledge mid-negotiation changes the next bid. Accept → round `locked` → `settling` | **Yes** (price drops live) |
| S3.4 | D9 PM | LLM narrators, buyer and supplier (Claude Sonnet 5.5), public-facts prompt builder, intent label | `src/agents/prompts.ts`, `src/negotiation/narrator.ts`, `src/supplier/narrator.ts` + tests | Property test: random sentinels in private fields never appear in serialized prompts. AI SDK mock model: narrator output is never parsed for numbers. Boundary rules 4 and 7 | **Yes** |
| S3.5 | D10 AM | Injection resistance + supplier red-team mode | `src/supplier/redteam.ts`, `test/integration/injection.test.ts`, `test/fixtures/injections/*.txt` | The 10 `injection-redteam` cases as fixtures (ignore-instructions, role spoof, fake quorum, fake final offer, currency switch, unit switch, unicode tricks, text/structured mismatch, edge values, limit-leak attempt) plus fast-check random text: policy verdicts identical with and without the text (invariant 9). Red-team "$19/kg" offer → `reject` with reason `above_coalition_limit` in turns | **Yes** (on-camera refusal) |
| S3.6 | D10 PM | Intake agent: one sentence → pledge draft → member confirms → sign | `src/agents/intake.ts`, `web/src/routes/Round.tsx` (intake panel) + tests, `test/llm/intake.llm.test.ts` | Mock model: structured output validated by zod; out-of-range qty or price rejected, not clamped. `pnpm test:llm`: 10 phrasings → correct fields ≥ 9/10 | **Yes** |
| S3.7 🅿 | D11 AM | Supplier fulfillment via Agent Toolkit (allowlist: invoice create/send/record-payment, tracking add) | `src/supplier/fulfillment.ts` + tests | Allowlist test: the toolkit is configured with exactly the listed tools, and any other tool name throws. Sandbox test: `round_settled` → invoice exists and is marked paid, tracking attached. Boundary rule 5 | **Yes** |
| S3.8 | D11 PM | Channel3 benchmark (cached + fixture fallback) + seeded failure round | `src/benchmark/channel3.ts` + test, `test/fixtures/channel3/*.json`, `scripts/seed-demo.ts` (failure scenario) | Recorded-fixture test maps a response to `best_unit_price_cents`; API error → falls back to cache. `smoke --scenario=no-deal` → `voided` with reason `no_deal` | **Yes** (savings %) |

**Exit:** `pnpm smoke --scenario=full` on Render: 3 bots + 1 live pledge → negotiated price → captures → invoice + tracking. `--scenario=redteam` shows the refusal in turns. `--scenario=no-deal` voids. **`injection-redteam` scores 10/10 refused**: no proposed capture price above L, no non-USD or non-integer offer accepted, and L never appears in any prompt or narrator output.

## Phase 4 — Sponsor surfaces (Days 12–15, Nov 2–5)

About 70% of sponsor effort goes into AG Studio (STRATEGY §3).

| ID | When | Slice | Files to create | Proving test | Demo-visible? |
|---|---|---|---|---|---|
| S4.1 | D12 | Cockpit shell in AG Studio: custom theme, read-model API, SSE wiring, **member authorization grid with honor-period countdown** | `web/src/cockpit/{Cockpit,theme,useRoundStream}.tsx`, `web/src/cockpit/widgets/AuthGrid.tsx`, `src/api/cockpit.ts` (read models) + tests | `cockpit.test.ts`: read model for a seeded round gives exact rows, countdown = `honor_ends_at − now`. Mapper unit test for the grid. Manual: the grid updates within 2 s of a bot pledge | **Yes** |
| S4.2 | D13 AM | Quorum thermometer + price-tier curve showing the live bid | `web/src/cockpit/widgets/{QuorumThermometer,TierCurve}.tsx` + mapper tests | Mapper tests: thermometer % = Σqty/target, capped display with an overflow marker. Tier curve marks the current bid and the accepted price | **Yes** |
| S4.3 | D13 PM | Negotiation transcript widget (verdict badges, injection highlight) + savings vs Channel3 widget | `web/src/cockpit/widgets/{Transcript,Savings}.tsx` + mapper tests | Supplier text rendered escaped (test with a `<script>` fixture). Savings % computed from cents with no float drift | **Yes** |
| S4.4 | D14 | **First** (R3 leftover, DECISIONS D5): an Anthropic adapter for `AgStudioAiModule` behind a server proxy, since the boilerplate's adapter is OpenAI-only. Then the Studio Agent Framework: custom "Coalition Agent" with read-only tools; "which pledges expire before delivery?" builds a widget through a built-in agent | `src/agents/analyst-tools.ts`, `web/src/cockpit/coalition-agent.ts` + tests | Tool tests on a seeded fixture: the expiring-pledges query returns exactly the expected ids. Boundary rule 4. Manual: the prompt builds a widget on camera | **Yes** |
| S4.5 | D15 AM | Bryntum Scheduler Pro round timeline with payment-gated dependencies; a void shifts delivery | `src/api/timeline.ts`, `web/src/timeline/RoundTimeline.tsx` + tests | `timelineFromRound()` unit tests: capture event blocked until `locked`; a voided pledge → delivery shifted per rule. Manual: live update on settle | **Yes** |
| S4.6 | D15 PM | `/supplier` console: offers received, red-team toggle, invoice + tracking | `web/src/routes/Supplier.tsx`, `src/api/supplier-view.ts` + test | Read-model test. The red-team toggle reaches the supplier via the signed protocol (contract test) | **Yes** |

**Exit:** all five cockpit widgets, the Studio agent and the timeline work live on Render during a `full` smoke run.

## Phase 5 — Polish / judge mode (Days 16–18, Nov 6–8)

| ID | When | Slice | Files to create | Proving test | Demo-visible? |
|---|---|---|---|---|---|
| S5.1 | D16 AM | `/judge`: "Run a full round" and "Run a failure round"; fresh round per run; optional live judge pledge | `src/api/judge.ts`, `web/src/routes/Judge.tsx` + tests | `smoke --scenario=judge` against local: click-equivalent API call → `fulfilled` in < 3 min; failure run → `voided` | **Yes** |
| S5.2 | D16 PM | Guards: judge-run rate limit, LLM token budget, `KILL_SWITCH`, demo-round cleanup (void anything left open > 2 h) | `src/api/guards.ts`, `src/worker/sweeps.ts` + tests | Rate limit returns 429 on the (n+1)th run per hour. Budget exceeded → narrator falls back to templated text and the round still completes. Sweep voids stale demo authorizations | No |
| S5.3 | D17 AM | Empty, error and loading states; mobile pledge page | `web/src/components/{Empty,ErrorState,Loading}.tsx`, Round.tsx polish | Mapper/render tests for empty round, PayPal popup cancelled, SSE disconnect → reconnect. Manual at 375 px | **Yes** |
| S5.4 | D17 PM | Observability + warm hosting: structured logs with round/op ids, extend `/healthz` (from S2.8) with a PayPal token check, paid Render instances through Dec 15 | `src/api/health.ts`, `src/log.ts` + test | Health returns 503 when the DB is down (fake). Logs include `paypal_debug_id` on errors | No |
| S5.5 | D18 | README (problem, mapping to the 5 criteria, architecture diagram, PayPal API → code map, setup, test commands), MIT LICENSE text, complete `.env.example`, hosted smoke | `README.md`, `LICENSE`, `.env.example`, `docs/diagram.svg` | `pnpm smoke --target=$RENDER_URL --scenario=judge` green. Incognito walkthrough checklist ticked | **Yes** (README is judged) |

**Exit:** a stranger can open the Render URL, click one button, and watch a full round, with no setup.

## Phase 6 — Video & submit (Days 19–22, Nov 9–12)

| ID | When | Slice | Files to create | Proving test | Demo-visible? |
|---|---|---|---|---|---|
| S6.1 | D19 | Script (≤ 2:50, STRATEGY storyboard), record takes against Render, capture PayPal sandbox views | `docs/VIDEO-SCRIPT.md` | Each storyboard beat has a recorded take. The hook states the problem in ≤ 15 s | **Yes** |
| S6.2 | D20 AM | Edit, upload to YouTube (public, not made for kids) | — | Video plays logged-out in incognito; runtime < 3:00 | **Yes** |
| S6.3 | D20 PM | Devpost form: criteria mapping, every PayPal API used and where it lives in the code, Built-with list, APIMatic claim form. **Submit** | `docs/DEVPOST.md` (draft copy) | Submission confirmed on Devpost | — |
| S6.4 | D21–22 | Buffer only: fix anything Devpost flags, final hosted smoke, confirm licenses and Render through Dec 15, tag the release | — | `smoke --scenario=judge` green on D22 morning | — |

## Stretch (needs explicit "go"; only from buffer time)

MCP server (`list_rounds`, `pledge`, `round_status`), Vault v3 one-tap pledges, Payouts rebates, dispute agent (`CUSTOMER.DISPUTE.CREATED`), multi-currency, fairness allocation (pro-rata vs priority).

## Cut order if behind schedule

Cut from the top (S4.6 is back in scope; see S2.9): S4.6 supplier console → S3.8 Channel3 (use the fixture only) → S4.5 Bryntum dependency-shift (keep a static timeline) → S3.6 intake agent (form instead). **Never cut:** S2.4–S2.7 (outbox and settlement), S3.5 (injection on camera), S4.1–S4.4 (AG Studio prize), S5.1 (judge mode).

## Decision gate log

| Date | Decision | Outcome |
|---|---|---|
| D1 (Oct 22) | PAYEE_MODE | **`coop_merchant`**: direct-payee void → 403 PERMISSION_DENIED; co-op-merchant capture + void work; reauth too soon → 422 (DECISIONS.md D1–D3) |
| D4 (Oct 22) | Bot authorization mode | **card-funded bots, demo mode only**: 3 single-step card authorizations, partial capture and void all work; human pledges stay on JS SDK v6 (DECISIONS D4) |
| D5 (Oct 22) | Studio + Bryntum layout | **one React 19 + Vite app, same route**: AG Studio 3.0.0 grid + Bryntum Scheduler Pro 7.3.7 trial render together. Console is clean apart from AG Studio's missing-key notice. Agent Framework moved to S4.4 as its first task (DECISIONS D5) |
| D7 (Oct 22) | Supplier DB isolation | **separate small Postgres** (`quorum-supplier-db`, added in S3.2) instead of a scoped role in a shared DB: isolation by config, no Render role privileges to discover |

## Changes from the original plan (Phase 1 close-out, 2026-10-22)

| # | Original plan | Now | Evidence |
|---|---|---|---|
| 1 | Supplier is the order's third-party `payee` | **Co-op is merchant of record**, no payee; S2.9 Payouts required | void on a third-party-payee authorization → 403 PERMISSION_DENIED (D1) |
| 2 | Reauthorize when the honor period is about to end | **Reauthorize only after it ends**, then capture the new id | 422 `REAUTHORIZATION_TOO_SOON` (D2) |
| 3 | Bot cards, conditions unknown | Card authorizations work, **demo mode only**; humans on JS SDK v6; single-step order, no `authorizeOrder` | R2 run (D4) |
| 4 | `@paypal/paypal-server-sdk` from npm | APIMatic Context Plugin's `paypal` git package, plus a Content-Type fetch wrapper; errors read from `payload.body` | 415 on body-less POSTs (D3) |
| 5 | Webhook verify via PayPal's postback API through the outbox | **Offline** signature verification, cert URL pinned | SDK has no verify call; outbox not built yet (D6) |
| 6 | Licences for both sponsors read from env | AG Studio: `VITE_AG_STUDIO_LICENSE_KEY`. **Bryntum has no runtime key** (npm package decides) | Bryntum typings and package docs (D5) |
| 7 | Separate `spikes/r3-studio` app | One `web/` Vite app with a `/spike` route; routes are code-split; the pledge page must load without AG Studio or Bryntum | 10 MB bundle; entry chunk is now 193 kB (D5) |
| 8 | R3 includes the Studio Agent Framework | Moved to S4.4, which starts with an Anthropic adapter | boilerplate's adapter is OpenAI-only (D5) |
| 9 | S1.4 deploys to Render | S1.4 **built, not deployed**; render.yaml, /health and env docs pulled forward from S2.8; the deploy is the user's dashboard steps | user's choice |
| 10 | Sandbox accounts: any | **All US**; Render free Postgres rejected (expires before judging); hosting ≈ $20–25/month | approval error; Render plans (D7) |
| 11 | Supplier: Invoicing only | **Invoice is the record, Payout pays it, supplier records the payment**; round states gain `invoiced`, `paid_out` | avoid double billing (ARCHITECTURE §3.4) |
| 12 | Payouts first exercised in S2.9 (D7) | **Proven on D1** (S1.5); dedupe is by `sender_batch_id`, not Request-Id | batch `3243HRX3TGYBY` SUCCESS; replay → 400 "already exists" |
| 13 | Supplier gets a scoped role in a shared Postgres | **Separate small Postgres** for the supplier | simpler isolation (D7) |
| 14 | Integration tests "against a local Postgres" (unspecified) | `pnpm db:up` Docker Postgres 17; required before `pnpm test` from S2.1 | healthy-DB path now proven locally |
| 15 | Phase 1 on D1–D3 | Closed on D1; ~2 days banked as buffer | — |

