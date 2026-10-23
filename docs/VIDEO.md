# Quorum — Demo video shot list (2:45, no slides)

Source: PLAYBOOK "Demo video blueprint". Recorded in S6.1 (D19) against the Render URL, edited and uploaded in S6.2.

**Rules**
- The first 5 seconds say what Quorum does. Money moves on screen by 1:30.
- 1080p screen recording plus voiceover. Show your face only in a small corner during the hook, then remove it.
- **Every PayPal action appears twice**: in Quorum, then in the PayPal sandbox activity page.
- Show the table stakes (policy gate, idempotent client, test count) for at most one frame each (PLAN Phase 5 note).

## Shots

| # | Time | On screen | Voiceover | Criterion | Needs (slice) | Take |
|---|---|---|---|---|---|---|
| 1 | 0:00–0:08 | Title card over the live cockpit: "Quorum: AI buying agents for small businesses, settled on PayPal" | "Chains buy at volume prices. Independent cafés pay 30 to 40% more. Quorum lets their AI agents buy together, and PayPal only takes the money if the deal clears." | Presentation, Impact | S4.1 cockpit | ☐ |
| 2 | 0:08–0:30 | Maya's phone: she types one sentence; the intake agent returns a mandate (15 kg/week, ≤ $14/kg, by Nov 30); she taps the PayPal button; sandbox approval; the thermometer ticks | "Each member signs a mandate and authorizes their maximum. No money moves yet." | Design, PayPal | S3.6, S2.5, S4.2 | ☐ |
| 3 | 0:30–0:40 | The QR code appears; a second phone scans it and taps "pledge as guest"; the thermometer ticks again | "Anyone can join from a phone. Judges, that QR is live in the hosted demo." | Demo Delivery | S5.7 (#1) | ☐ |
| 4 | 0:40–1:15 | Negotiation Replay split pane: LLM message left, deterministic move right; the tier drops as members join; press **Attack**; the refusal shows | "The agent bargains for the whole coalition. The language model only writes the words; a rules engine decides every price, and the ceiling is never in the prompt. Watch it refuse an injected instruction." | Innovation, Tech | S3.9 (#3), S3.5 | ☐ |
| 5 | 1:15–1:40 | Quorum reached; captures run; cut to the sandbox activity page showing partial captures at the lower price; the supplier Payout; the Invoice marked paid; the tracking number | "Eight members. Each authorization is captured for the final price, below what they approved. The supplier is paid, invoiced and tracked, all on PayPal." | PayPal+AI, Agentic Commerce | S2.7, S2.9, S3.7 | ☐ |
| 6 | 1:40–1:52 | A second round misses quorum: every authorization voided; the sandbox page shows VOIDED | "When quorum fails, nobody pays. All-or-nothing, enforced by code." | Tech | S2.7, S3.8 failure round | ☐ |
| 7 | 1:52–2:20 | Cockpit: drag the what-if slider; ask the Studio agent "which pledges expire before delivery"; a widget appears; the Bryntum timeline shows delivery unblocked after capture | "The co-op cockpit is built on AG Studio with custom widgets, and the schedule on Bryntum, where a late payment visibly blocks delivery." | Design, AG Grid, Bryntum | S4.7 (#4), S4.4, S4.5 | ☐ |
| 8 | 2:20–2:35 | The Settlement Receipt opens; click a capture id and land on the sandbox transaction; `pnpm verify-receipt` passes in a terminal | "Every member gets a signed receipt of every check that led to their charge." | Tech, Impact | S5.6 (#2) | ☐ |
| 9 | 2:35–2:45 | Architecture diagram (one frame); the README red-team scoreboard; repo and demo URL | "Open source, hosted on Render, built with the APIMatic PayPal SDK. Chains have procurement departments. Now corner shops have agents." | Presentation | S5.5; scoreboard is S5.10 (#8, dropped by the cap: show the S3.5 test output instead unless it's built) | ☐ |

## Upload (S6.2)

- **Title**: "Quorum: AI agents that buy together on PayPal (PayPal AI Hackathon)"
- **Thumbnail**: the split-pane negotiation with the price dropping and "REFUSED" visible. No logos we don't own.
- Public, not "made for kids". Chapters in the description, one per shot above.
- Under 3:00. No third-party music.
