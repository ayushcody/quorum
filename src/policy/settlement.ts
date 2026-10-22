import { allocate } from "./allocate.ts";
import { coalitionLimit, meetsQuorum, type Quorum } from "./clearing.ts";
import type { Mandate } from "./mandate.ts";
import { addCents, mulCents, type Cents } from "./money.ts";
import type { AuthorizationStatus, PledgeStatus, RoundStatus } from "./state.ts";

// evaluateRound: the one place that decides whether a round's money is captured, voided, or
// reauthorized (ARCHITECTURE §3.2, invariants §6). Pure: same snapshot + now → same decision.

export type AuthorizationSnapshot = { authorizationId: string; amountCents: Cents; status: AuthorizationStatus; honorEndsAt: Date; expiresAt: Date };
export type PledgeSnapshot = { pledgeId: string; mandate: Mandate; status: PledgeStatus; authorization: AuthorizationSnapshot | null };
export type RoundSnapshot = {
  roundId: string;
  status: RoundStatus;
  targetQty: number;
  minMembers: number;
  pledgeDeadlineAt: Date;
  finalUnitPriceCents: Cents | null;
  supplyCap?: number;
  pledges: PledgeSnapshot[];
};

export type Capture = { pledgeId: string; authorizationId: string; qty: number; amountCents: Cents };
export type Release = { pledgeId: string; authorizationId: string; reason: "below_price" | "mandate_expired" | "authorization_too_small" };
export type SettlementPlan = { unitPriceCents: Cents; captures: Capture[]; voids: Release[]; totalQty: number; totalCents: Cents };
export type Decision =
  | { kind: "noop" }
  | { kind: "wait"; reason: "pledging" }
  | { kind: "reauth"; authorizationIds: string[] }
  | { kind: "settle"; plan: SettlementPlan }
  | { kind: "abort"; reason: "no_quorum" | "no_deal"; voids: { pledgeId: string; authorizationId: string }[] };

type LivePledge = PledgeSnapshot & { authorization: AuthorizationSnapshot };

const byPledgeId = <T extends { pledgeId: string }>(a: T, b: T) => (a.pledgeId < b.pledgeId ? -1 : a.pledgeId > b.pledgeId ? 1 : 0);

// A hold PayPal will still honour: created and not past its expiry. Anything else is ignored, never touched.
function isLive(p: PledgeSnapshot, now: number): p is LivePledge {
  return p.authorization !== null && p.authorization.status === "created" && now < p.authorization.expiresAt.getTime();
}

export function evaluateRound(snapshot: RoundSnapshot, now: Date): Decision {
  const t = now.getTime();
  if (snapshot.status !== "open" && snapshot.status !== "locked") return { kind: "noop" };

  const live = snapshot.pledges.filter((p): p is LivePledge => isLive(p, t)).sort(byPledgeId);
  const quorum: Quorum = { targetQty: snapshot.targetQty, minMembers: snapshot.minMembers };
  // Abort is all-or-nothing: every live hold is released.
  const abort = (reason: "no_quorum" | "no_deal"): Decision => ({
    kind: "abort",
    reason,
    voids: live.map((p) => ({ pledgeId: p.pledgeId, authorizationId: p.authorization.authorizationId })),
  });

  if (snapshot.status === "open" && t < snapshot.pledgeDeadlineAt.getTime()) return { kind: "wait", reason: "pledging" };
  const price = snapshot.status === "locked" ? snapshot.finalUnitPriceCents : null;
  if (price === null) {
    // Past the pledge deadline with no accepted price: say whether quorum was ever possible.
    const bids = live.map((p) => ({ pledgeId: p.pledgeId, maxUnitPriceCents: p.mandate.maxUnitPriceCents, qtyMax: p.mandate.qtyMax }));
    return abort(coalitionLimit(bids, quorum) === null ? "no_quorum" : "no_deal");
  }

  // Participants: live holds whose ceiling covers the price and whose mandate is still in force.
  const releases: Release[] = [];
  let participants: LivePledge[] = [];
  for (const p of live) {
    const release = (reason: Release["reason"]) => releases.push({ pledgeId: p.pledgeId, authorizationId: p.authorization.authorizationId, reason });
    if (p.mandate.maxUnitPriceCents < price) release("below_price");
    else if (p.mandate.deadlineAt.getTime() <= t) release("mandate_expired");
    else participants.push(p);
  }
  const quorumOf = (ps: LivePledge[]) => meetsQuorum(ps.map((p) => ({ qtyMax: p.mandate.qtyMax })), quorum);
  if (!quorumOf(participants)) return abort("no_quorum");

  // Past the honor period PayPal may not honour the capture: reauthorize first (DECISIONS D2).
  const pastHonor = participants.filter((p) => t >= p.authorization.honorEndsAt.getTime());
  if (pastHonor.length > 0) return { kind: "reauth", authorizationIds: pastHonor.map((p) => p.authorization.authorizationId).sort() };

  // Allocate; release any hold too small for its share and re-allocate, until it's stable.
  let allocation: Map<string, number>;
  for (;;) {
    const next = allocate(participants.map((p) => ({ pledgeId: p.pledgeId, qtyMin: p.mandate.qtyMin, qtyMax: p.mandate.qtyMax })), snapshot.supplyCap);
    if (next === null) return abort("no_quorum");
    const tooSmall = participants.filter((p) => mulCents(price, next.get(p.pledgeId)!) > p.authorization.amountCents);
    if (tooSmall.length === 0) {
      allocation = next;
      break;
    }
    for (const p of tooSmall) releases.push({ pledgeId: p.pledgeId, authorizationId: p.authorization.authorizationId, reason: "authorization_too_small" });
    participants = participants.filter((p) => !tooSmall.includes(p));
    if (!quorumOf(participants)) return abort("no_quorum");
  }

  const captures: Capture[] = participants.map((p) => {
    const qty = allocation.get(p.pledgeId)!;
    return { pledgeId: p.pledgeId, authorizationId: p.authorization.authorizationId, qty, amountCents: mulCents(price, qty) };
  });
  const totalQty = captures.reduce((s, c) => s + c.qty, 0);
  // A supply cap can cut allocations below the target even when ceilings and counts qualify.
  if (totalQty < snapshot.targetQty || captures.length < snapshot.minMembers) return abort("no_quorum");

  return {
    kind: "settle",
    plan: {
      unitPriceCents: price,
      captures: captures.sort(byPledgeId),
      voids: releases.sort(byPledgeId),
      totalQty,
      totalCents: addCents(...captures.map((c) => c.amountCents)),
    },
  };
}
