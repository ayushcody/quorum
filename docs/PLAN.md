# Quorum — Build Plan (22 days, solo)

Window: **Day 1 = Thu Oct 22 → Day 22 = Thu Nov 12 (deadline 12:00 PST)**. Submit on **Day 20 (Tue Nov 10)**.
Design reference: `docs/ARCHITECTURE.md`. Product intent: `docs/STRATEGY.md`.

**Current phase: Phase 1 — Risky spikes.** Build only slices in the current phase. Advance this line only when the phase's exit criteria are met.

## Ground rules (from CLAUDE.md, applied to every slice)

- A slice is ≤ 1 day: **AM** ≈ half day, **PM** ≈ half day, **D** = full day. Each slice ends with `pnpm test && pnpm typecheck` green.
- Write the failing test first. The "Proving test" column names that test.
- A slice that touches PayPal or the APIMatic SDK ends with 3 lines appended to `docs/BUILD-LOG.md` (what, prompt, outcome). These slices are tagged 🅿.
- **Demo-visible?** means it appears in the video or in judge mode. "No" slices are still required.
- Test tiers: `pnpm test` (unit, property, integration against a local Postgres, and a fake PayPal port; no network). `pnpm test:sandbox` (live PayPal sandbox, opt-in). `pnpm test:llm` (live Claude evals, opt-in). The two opt-in scripts are added in S1.0.
- Each new dependency's reason goes in its commit message (see ARCHITECTURE §8).

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
| S1.4 🅿 | D3 PM | Deploy a hello Hono app to Render (web + Postgres). Register the sandbox webhook. Receive and verify `PAYMENT.AUTHORIZATION.CREATED` from S1.2. Try creating the `supplier` DB role. **Decision gate** | `src/api/app.ts` (hello + `/webhooks/paypal` log-only), `render.yaml`, `docs/DECISIONS.md` | A Render-hosted event shows up in the logs with `verify-webhook-signature` = SUCCESS. `DECISIONS.md` records PAYEE_MODE, bot mode, Studio layout, DB role | No |

**Exit criteria / decision gate (end of D3):** R1–R3 each marked confirmed or fallback chosen in `docs/DECISIONS.md`. ARCHITECTURE §3.5 updated with verified facts. If more than one fallback is triggered, cut a stretch item and re-sequence Phase 2 before starting it.

## Phase 2 — Payment backbone (Days 4–7, Oct 25–28)

| ID | When | Slice | Files to create | Proving test | Demo-visible? |
|---|---|---|---|---|---|
| S2.1 | D4 AM | Data model + migrations + base seed | `src/db/schema.ts`, `src/db/client.ts`, `src/db/migrations/*`, `drizzle.config.ts`, `scripts/seed-demo.ts` (members, one round) | `test/integration/schema.test.ts`: migrate an empty DB; duplicate `paypal_ops.business_key` rejected; `captured_cents > amount_cents` rejected; `UNIQUE(round_id, member_id)` on mandates | No |
| S2.2 | D4 PM | Policy kernel v1: money, mandate validation, clearing, allocate, `evaluateRound`, state machines | `src/policy/{money,mandate,clearing,allocate,settlement,state,index}.ts` + `*.test.ts` | fast-check invariants 1–7 and 10 (ARCHITECTURE §6). Example tests: no-quorum → Abort; low-ceiling member released while quorum holds | No |
| S2.3 | D5 AM | Mandate canonicalization + ECDSA P-256 sign/verify; `VerifiedMandate` brand | `src/pledge/mandate-sign.ts`, `src/pledge/mandate-sign.test.ts` | Tampering with any field → verify fails. Key order doesn't change the hash. `VerifiedMandate` can't be built outside the module (type test with `@ts-expect-error`) | No |
| S2.4 🅿 | D5 PM | PayPal wrapper + outbox: `paypalCall`, UUIDv5 request ids, claim/complete, error classifier, fake port | `src/paypal/{client,call,orders,payments,webhooks,port,fake}.ts`, `src/outbox/{repo,request-id,errors,reconcile}.ts` + tests | Same business key twice → 1 row, 1 port call. Crash after insert → retry reuses the request id. Timeout → `unknown` → reconcile GET → `succeeded`. Boundary rules 2–3 pass | No |
| S2.5 🅿 | D6 AM | Pledge flow: create-order and authorize routes, v6 button on `/round/:id` (bare UI), bot path in seed | `src/pledge/{service,routes}.ts`, `web/index.html`, `web/src/main.tsx`, `web/src/routes/Round.tsx`, `web/src/paypal/v6.ts`, `vite.config.ts` | `test/integration/pledge.test.ts` (fake port): pledge → order_created → authorized, with the mandate hash in `custom_id`. `pledge.sandbox.test.ts`: a bot pledge authorizes live | **Yes** (member approves on PayPal) |
| S2.6 🅿 | D6 PM | Webhook inbox: verify, dedupe, reconcile, `evaluateRound`, audit | `src/webhooks/{routes,handlers}.ts` + tests, `test/fixtures/webhooks/*.json` | Same event twice → one transition. Bad signature → stored with `verified=false`, not processed. AUTHORIZATION.CREATED for an already-authorized pledge → no-op | Yes (webhook log in cockpit later) |
| S2.7 🅿 | D7 AM | Settlement worker: preflight, capture-all, void-all, reauth-before-settle, unwind (refund + void), tick loop | `src/settlement/{worker,planner}.ts`, `src/worker/main.ts` + tests | Fake-port scenarios: happy path; one capture fails after 2 succeed → Unwind refunds 2, voids rest; honor window near → reauth then capture new id; worker killed mid-batch → restart, no duplicate capture. Boundary rule 3 | **Yes** (captures and voids) |
| S2.8 🅿 | D7 PM | Fixed-price round end-to-end on Render (no negotiation yet) + plain audit page | `src/api/{cockpit,sse}.ts`, `web/src/routes/Audit.tsx`, `scripts/smoke.ts`, `render.yaml` (web + worker + db) | `pnpm smoke --target=$RENDER_URL --scenario=fixed`: 3 bots + quorum → `settled` and captures visible via GET. `--scenario=no-quorum` → `voided` | **Yes** |
| S2.9 🅿 | Only if R1 failed: D7 PM. S2.8 then moves to D8 AM, S3.1 + S3.2 share D8 PM, and S4.6 is cut to recover | `coop_merchant` mode: orders without payee, Payouts to supplier after settle | `src/settlement/payout.ts`, tests | Fake port: `settled` → exactly one `payout:{roundId}` op. Sandbox: payout lands in the supplier account | Yes |

**Exit:** a real sandbox round settles and a no-quorum round voids, both on Render, driven by `scripts/smoke.ts`.

## Phase 3 — Agents (Days 8–11, Oct 29–Nov 1)

| ID | When | Slice | Files to create | Proving test | Demo-visible? |
|---|---|---|---|---|---|
| S3.1 | D8 AM | Concession engine + accept rule; coalition limit re-computed as pledges change | `src/policy/{concession,accept}.ts` + tests | fast-check: bid monotone, `≤ L`, accepts only `p ≤ L`. Walks at k=N if `p > L`. Adding a pledge never lowers L (invariant 8 + L monotonicity) | No |
| S3.2 | D8 PM | Supplier service skeleton: own entrypoint, env, DB schema, HMAC protocol, deterministic strategy (no LLM yet) | `src/protocol/{messages,hmac}.ts`, `src/supplier/{main,env,db,strategy}.ts` + tests, Render service in `render.yaml` | Contract test: signed offer → counter. Bad HMAC → 401. Replayed nonce → 409. Boundary rule 6 | No |
| S3.3 | D9 AM | Negotiation orchestrator in the worker: ticks, turns, re-quote on quantity change, accept → lock → settle | `src/negotiation/{orchestrator,supplier-client}.ts` + tests | Integration with a stub narrator and an in-process supplier: given seed pledges and a supplier floor, it converges in ≤ 6 turns to the expected price. A new pledge mid-negotiation changes the next bid. Accept → round `locked` → `settling` | **Yes** (price drops live) |
| S3.4 | D9 PM | LLM narrators, buyer and supplier (Claude Sonnet 5.5), public-facts prompt builder, intent label | `src/agents/prompts.ts`, `src/negotiation/narrator.ts`, `src/supplier/narrator.ts` + tests | Property test: random sentinels in private fields never appear in serialized prompts. AI SDK mock model: narrator output is never parsed for numbers. Boundary rules 4 and 7 | **Yes** |
| S3.5 | D10 AM | Injection resistance + supplier red-team mode | `src/supplier/redteam.ts`, `test/integration/injection.test.ts`, `test/fixtures/injections/*.txt` | ≥ 10 injection fixtures plus fast-check random text: policy verdicts identical with and without the text (invariant 9). Red-team "$19/kg" offer → `reject` with reason `above_coalition_limit` in turns | **Yes** (on-camera refusal) |
| S3.6 | D10 PM | Intake agent: one sentence → pledge draft → member confirms → sign | `src/agents/intake.ts`, `web/src/routes/Round.tsx` (intake panel) + tests, `test/llm/intake.llm.test.ts` | Mock model: structured output validated by zod; out-of-range qty or price rejected, not clamped. `pnpm test:llm`: 10 phrasings → correct fields ≥ 9/10 | **Yes** |
| S3.7 🅿 | D11 AM | Supplier fulfillment via Agent Toolkit (allowlist: invoice create/send/record-payment, tracking add) | `src/supplier/fulfillment.ts` + tests | Allowlist test: the toolkit is configured with exactly the listed tools, and any other tool name throws. Sandbox test: `round_settled` → invoice exists and is marked paid, tracking attached. Boundary rule 5 | **Yes** |
| S3.8 | D11 PM | Channel3 benchmark (cached + fixture fallback) + seeded failure round | `src/benchmark/channel3.ts` + test, `test/fixtures/channel3/*.json`, `scripts/seed-demo.ts` (failure scenario) | Recorded-fixture test maps a response to `best_unit_price_cents`; API error → falls back to cache. `smoke --scenario=no-deal` → `voided` with reason `no_deal` | **Yes** (savings %) |

**Exit:** `pnpm smoke --scenario=full` on Render: 3 bots + 1 live pledge → negotiated price → captures → invoice + tracking. `--scenario=redteam` shows the refusal in turns. `--scenario=no-deal` voids.

## Phase 4 — Sponsor surfaces (Days 12–15, Nov 2–5)

About 70% of sponsor effort goes into AG Studio (STRATEGY §3).

| ID | When | Slice | Files to create | Proving test | Demo-visible? |
|---|---|---|---|---|---|
| S4.1 | D12 | Cockpit shell in AG Studio: custom theme, read-model API, SSE wiring, **member authorization grid with honor-period countdown** | `web/src/cockpit/{Cockpit,theme,useRoundStream}.tsx`, `web/src/cockpit/widgets/AuthGrid.tsx`, `src/api/cockpit.ts` (read models) + tests | `cockpit.test.ts`: read model for a seeded round gives exact rows, countdown = `honor_ends_at − now`. Mapper unit test for the grid. Manual: the grid updates within 2 s of a bot pledge | **Yes** |
| S4.2 | D13 AM | Quorum thermometer + price-tier curve showing the live bid | `web/src/cockpit/widgets/{QuorumThermometer,TierCurve}.tsx` + mapper tests | Mapper tests: thermometer % = Σqty/target, capped display with an overflow marker. Tier curve marks the current bid and the accepted price | **Yes** |
| S4.3 | D13 PM | Negotiation transcript widget (verdict badges, injection highlight) + savings vs Channel3 widget | `web/src/cockpit/widgets/{Transcript,Savings}.tsx` + mapper tests | Supplier text rendered escaped (test with a `<script>` fixture). Savings % computed from cents with no float drift | **Yes** |
| S4.4 | D14 | Studio Agent Framework: custom "Coalition Agent" with read-only tools; "which pledges expire before delivery?" builds a widget through a built-in agent | `src/agents/analyst-tools.ts`, `web/src/cockpit/coalition-agent.ts` + tests | Tool tests on a seeded fixture: the expiring-pledges query returns exactly the expected ids. Boundary rule 4. Manual: the prompt builds a widget on camera | **Yes** |
| S4.5 | D15 AM | Bryntum Scheduler Pro round timeline with payment-gated dependencies; a void shifts delivery | `src/api/timeline.ts`, `web/src/timeline/RoundTimeline.tsx` + tests | `timelineFromRound()` unit tests: capture event blocked until `locked`; a voided pledge → delivery shifted per rule. Manual: live update on settle | **Yes** |
| S4.6 | D15 PM | `/supplier` console: offers received, red-team toggle, invoice + tracking | `web/src/routes/Supplier.tsx`, `src/api/supplier-view.ts` + test | Read-model test. The red-team toggle reaches the supplier via the signed protocol (contract test) | **Yes** |

**Exit:** all five cockpit widgets, the Studio agent and the timeline work live on Render during a `full` smoke run.

## Phase 5 — Polish / judge mode (Days 16–18, Nov 6–8)

| ID | When | Slice | Files to create | Proving test | Demo-visible? |
|---|---|---|---|---|---|
| S5.1 | D16 AM | `/judge`: "Run a full round" and "Run a failure round"; fresh round per run; optional live judge pledge | `src/api/judge.ts`, `web/src/routes/Judge.tsx` + tests | `smoke --scenario=judge` against local: click-equivalent API call → `fulfilled` in < 3 min; failure run → `voided` | **Yes** |
| S5.2 | D16 PM | Guards: judge-run rate limit, LLM token budget, `KILL_SWITCH`, demo-round cleanup (void anything left open > 2 h) | `src/api/guards.ts`, `src/worker/sweeps.ts` + tests | Rate limit returns 429 on the (n+1)th run per hour. Budget exceeded → narrator falls back to templated text and the round still completes. Sweep voids stale demo authorizations | No |
| S5.3 | D17 AM | Empty, error and loading states; mobile pledge page | `web/src/components/{Empty,ErrorState,Loading}.tsx`, Round.tsx polish | Mapper/render tests for empty round, PayPal popup cancelled, SSE disconnect → reconnect. Manual at 375 px | **Yes** |
| S5.4 | D17 PM | Observability + warm hosting: structured logs with round/op ids, `/healthz` (DB + PayPal token), paid Render instances through Dec 15 | `src/api/health.ts`, `src/log.ts` + test | Health returns 503 when the DB is down (fake). Logs include `paypal_debug_id` on errors | No |
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

Cut from the top: S4.6 supplier console → S3.8 Channel3 (use the fixture only) → S4.5 Bryntum dependency-shift (keep a static timeline) → S3.6 intake agent (form instead). **Never cut:** S2.4–S2.7 (outbox and settlement), S3.5 (injection on camera), S4.1–S4.4 (AG Studio prize), S5.1 (judge mode).

## Decision gate log

| Date | Decision | Outcome |
|---|---|---|
| D3 | PAYEE_MODE | _pending R1_ |
| D3 | Bot authorization mode | _pending R2_ |
| D3 | Studio + Bryntum layout | _pending R3_ |
| D3 | Supplier DB role on Render | _pending S1.4_ |
