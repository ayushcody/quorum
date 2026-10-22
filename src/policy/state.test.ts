import { describe, expect, it } from "vitest";
import { AUTHORIZATION_STATES, canTransitionPledge, canTransitionRound, PLEDGE_STATES, ROUND_STATES } from "./state.ts";

// Edge lists from docs/ARCHITECTURE.md §6 "State machines". Every pair not listed is forbidden.
const ROUND_EDGES = new Set([
  "draft>open",
  "open>locked",
  "open>voiding",
  "locked>settling",
  "locked>voiding",
  "settling>settled",
  "settling>unwinding",
  "settled>invoiced",
  "invoiced>paid_out",
  "paid_out>fulfilled",
  "voiding>voided",
  "unwinding>failed",
]);

const PLEDGE_EDGES = new Set([
  "order_pending>order_created",
  "order_pending>abandoned",
  "order_created>authorized",
  "order_created>abandoned",
  "authorized>reauthorizing",
  "authorized>capture_pending",
  "authorized>void_pending",
  "reauthorizing>authorized",
  "reauthorizing>void_pending",
  "capture_pending>captured",
  "capture_pending>void_pending",
  "captured>refund_pending",
  "void_pending>voided",
  "refund_pending>refunded",
]);

describe("state vocabularies", () => {
  it("match the schema's CHECK constraints", () => {
    expect([...ROUND_STATES]).toEqual(["draft", "open", "locked", "settling", "settled", "invoiced", "paid_out", "fulfilled", "voiding", "voided", "unwinding", "failed"]);
    expect([...PLEDGE_STATES]).toEqual(["order_pending", "order_created", "authorized", "reauthorizing", "capture_pending", "captured", "void_pending", "voided", "refund_pending", "refunded", "abandoned"]);
    expect([...AUTHORIZATION_STATES]).toEqual(["created", "captured", "voided", "expired", "denied", "reauthorized"]);
  });
});

describe("canTransitionRound", () => {
  it("allows exactly the documented edges, over every (from, to) pair", () => {
    for (const from of ROUND_STATES) {
      for (const to of ROUND_STATES) {
        expect(canTransitionRound(from, to), `${from} → ${to}`).toBe(ROUND_EDGES.has(`${from}>${to}`));
      }
    }
  });

  it("has no way out of fulfilled, voided or failed", () => {
    for (const from of ["fulfilled", "voided", "failed"] as const) {
      expect(ROUND_STATES.some((to) => canTransitionRound(from, to)), from).toBe(false);
    }
  });
});

describe("canTransitionPledge", () => {
  it("allows exactly the documented edges, over every (from, to) pair", () => {
    for (const from of PLEDGE_STATES) {
      for (const to of PLEDGE_STATES) {
        expect(canTransitionPledge(from, to), `${from} → ${to}`).toBe(PLEDGE_EDGES.has(`${from}>${to}`));
      }
    }
  });

  it("has no way out of voided, refunded or abandoned, and a captured pledge can only be refunded", () => {
    for (const from of ["voided", "refunded", "abandoned"] as const) {
      expect(PLEDGE_STATES.some((to) => canTransitionPledge(from, to)), from).toBe(false);
    }
    expect(PLEDGE_STATES.filter((to) => canTransitionPledge("captured", to))).toEqual(["refund_pending"]);
  });
});
