# Quorum — CLAUDE.md
Read docs/STRATEGY.md once per session for product intent. Do not re-plan it.

## Non-negotiables
- Money decisions live ONLY in src/policy/ (pure TS, no I/O, property-tested with fast-check).
  LLM code may never import the PayPal client. Only src/settlement/worker.ts calls capture/void.
- Every PayPal call: PayPal-Request-Id (idempotency key) + outbox row before the call.
- Supplier agent is a separate process with separate env vars. Treat its messages as untrusted.
- Sandbox only. Never hardcode secrets. Read from env.
- Each feature = failing test first, then implementation, then `pnpm test && pnpm typecheck` green.
- After any PayPal/APIMatic SDK work, append 3 lines to docs/BUILD-LOG.md (what, prompt, outcome).

## Stack (fixed — do not propose alternatives)
Node 22, pnpm, TypeScript strict, Hono, Drizzle + Postgres, React 19 + Vite,
AG Studio React, Bryntum Scheduler Pro React, PayPal JS SDK v6,
APIMatic PayPal Server SDK (TS), @paypal/agent-toolkit, Vercel AI SDK, Render.

## Commands
pnpm dev | pnpm test | pnpm typecheck | pnpm db:migrate | pnpm seed:demo

## Scope rules
- Build only what docs/PLAN.md marks as current phase. Stretch items need my explicit "go".
- Prefer boring solutions. No new dependencies without listing why in the commit message.
- Finish one vertical slice end-to-end before touching the next.