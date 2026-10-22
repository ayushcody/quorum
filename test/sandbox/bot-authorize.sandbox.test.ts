import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadCoordinatorEnv } from "../../src/config/env.ts";
import { sandboxClient } from "../../spikes/r1/clients.ts";
import { capturePartial, getAuthorization, voidAuthorization } from "../../spikes/r1/lifecycle.ts";
import { loadSandboxCard } from "../../spikes/r2/card.ts";
import { authorizeBots, printTable, type BotRow } from "../../spikes/r2/bots.ts";

// R2 (docs/PLAN.md S1.2): card-funded bot members authorize with no buyer approval step.
// Demo mode only (DECISIONS D4). PAYEE_MODE=coop_merchant per D1: no payee on the order.

describe("R2: card-funded bot authorizations", () => {
  const env = loadCoordinatorEnv();
  const client = sandboxClient(env.PAYPAL_CLIENT_ID, env.PAYPAL_CLIENT_SECRET);
  const card = loadSandboxCard(process.env);
  const rows: BotRow[] = [];

  it("authorizes 3 bots, captures 60% of one and voids another", async () => {
    const bots = await authorizeBots(client, { card, count: 3, amountCents: 1000 });
    rows.push(...bots);
    for (const bot of bots) {
      expect(bot.ok, JSON.stringify(bot)).toBe(true);
      expect(bot.authorizationStatus).toBe("CREATED");
      expect(bot.customId).toBe(bot.mandateHash);
    }
    const [first, second, third] = bots as [BotRow, BotRow, BotRow];

    const capture = await capturePartial(client, first.authorizationId!, 600);
    rows.push({ label: `${first.label} capture`, ok: capture.ok, captureId: capture.ok ? capture.value.id : undefined, captureStatus: capture.ok ? capture.value.status : `FAILED ${JSON.stringify(capture)}` });
    expect(capture.ok && capture.value.status, JSON.stringify(capture)).toBe("COMPLETED");
    const firstAfter = await getAuthorization(client, first.authorizationId!);
    expect(firstAfter.ok && firstAfter.value.status).toBe("CAPTURED");

    const voided = await voidAuthorization(client, second.authorizationId!);
    rows.push({ label: `${second.label} void`, ok: voided.ok, authorizationId: second.authorizationId, authorizationStatus: voided.ok ? voided.value.status : `FAILED ${JSON.stringify(voided)}` });
    expect(voided.ok && voided.value.status, JSON.stringify(voided)).toBe("VOIDED");

    // Left open on purpose: DECISIONS D2 follow-up reauthorizes it after the honor period.
    const thirdNow = await getAuthorization(client, third.authorizationId!);
    expect(thirdNow.ok && thirdNow.value.status).toBe("CREATED");

    printTable(rows);
    writeFileSync("spikes/r2/results.json", `${JSON.stringify({ at: new Date().toISOString(), rows }, null, 2)}\n`);
  });
});
