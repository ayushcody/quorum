# Quorum — Submission tasks (Devpost page, README, QA)

Source: PLAYBOOK "Devpost page and README blueprint" and "Pre-submission QA". The page is written for a judge with five minutes who may never open the repo: sponsor names they can Cmd-F, one sentence per criterion, the video first. Keep Devpost's default headings and put the blocks below inside them. Owner: S5.5 (README), S6.3 (Devpost, QA, submit on Nov 10).

## Devpost description (in this order)

- [ ] **Tagline** under the title: "AI buying agents for independent businesses: pledge with PayPal, negotiate as a coalition, pay only if the deal clears."
- [ ] **Inspiration** (3 sentences): the price gap, the spreadsheet co-op, the person who fronts the cash.
- [ ] **What it does**: 5 bullets, one per stage (pledge, negotiate, settle or void, pay the supplier, receipt).
- [ ] **How we built it**: a table with one row per PayPal API (Orders v2 AUTHORIZE, Payments capture/void/reauthorize, Payouts, Invoicing, Shipment tracking, Webhooks, Agent Toolkit, MCP) and one row per sponsor (AG Studio, Bryntum, APIMatic Context Plugin and Server SDK, Channel3, Render), each with the file path and the screen where it appears.
- [ ] **Judging criteria**: five bold headings matching the rubric word for word, two sentences each.
- [ ] **Try it in 60 seconds**: hosted URL, the QR pledge page, the judge credentials or the guest path, and `pnpm dev` with no keys for replay mode.
- [ ] **Challenges**: the third-party payee refusal (403 on void, D1) and the 72-hour honor period (D2), each with what we changed.
- [ ] **What's next**: three roadmap items framed as scoped-out decisions.
- [ ] Lead with multi-party all-or-nothing settlement plus coalition negotiation. The policy gate, idempotency and test count get one line each (PLAN Phase 5 "table stakes").

## Gallery (five images, 1920×1080, in this order)

- [ ] 1. Split-pane negotiation with REFUSED visible. This is the card thumbnail, so it must read at 300 px wide.
- [ ] 2. Cockpit with the thermometer and the what-if slider.
- [ ] 3. PayPal sandbox activity page showing captures, beside Quorum's settlement screen.
- [ ] 4. The Settlement Receipt.
- [ ] 5. The architecture diagram.

## Built With tags

- [ ] paypal, paypal-orders-v2, paypal-payouts, paypal-agent-toolkit, mcp, ag-grid, ag-studio, bryntum, apimatic, channel3, render, typescript, react, hono, postgres, vercel-ai-sdk, anthropic, claude. Drop `mcp` if #9 isn't built.

## README (top to bottom, S5.5)

- [ ] A 20-second GIF of the attack refusal.
- [ ] The tagline.
- [ ] "Judges: run it in 60 seconds".
- [ ] The architecture diagram (`docs/diagram.svg`).
- [ ] A criteria-to-code table.
- [ ] The red-team scoreboard (generated if S5.10 is built; otherwise the S3.5 test output).
- [ ] The PayPal API coverage table.
- [ ] The sponsor usage table with screenshots.
- [ ] Setup.
- [ ] Tests: `pnpm test`, the count, the property tests named.
- [ ] Links to DECISIONS.md and BUILD-LOG.md.
- [ ] MIT license badge, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`.
- [ ] GitHub "About" sidebar: description, topics, demo link.

## Pre-submission QA (Nov 10, from a device and browser never used for the project)

- [ ] The hosted URL loads in under 3 s cold; the QR pledge page works on a phone over mobile data.
- [ ] A full successful round and a full failed round run from the judge page without any setup.
- [ ] Every PayPal id shown in the UI resolves in the sandbox activity page.
- [ ] A stranger cannot capture, void or pay out anything; the MCP and guest endpoints are rate-limited (ARCHITECTURE §10; `test/arch/public-surface.test.ts` green).
- [ ] `git clone` → `pnpm dev` with no keys reaches replay mode (S3.9); with keys, it reaches the sandbox.
- [ ] `pnpm test` and the red-team suite pass on main; the README scoreboard matches.
- [ ] The LICENSE shows in the GitHub About sidebar; description, topics and demo URL are set.
- [ ] The video is public, under 3:00, with no third-party music or logos and chapters in the description.
- [ ] Devpost fields: video link, repo link, hosted URL, and every sponsor named both in Built With and in the text.
- [ ] AG Studio and Bryntum licenses are valid through Dec 15, confirmed in writing on Discord.
- [ ] The Render instance is on a paid plan, with health alerts to your email.
- [ ] Submitted by Nov 10, 23:59 your time; the Devpost confirmation email is saved.
