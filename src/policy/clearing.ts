import type { Cents } from "./money.ts";

export type Quorum = { targetQty: number; minMembers: number };
export type Bid = { pledgeId: string; maxUnitPriceCents: Cents; qtyMax: number };

export function meetsQuorum(members: ReadonlyArray<{ qtyMax: number }>, quorum: Quorum): boolean {
  return members.reduce((sum, m) => sum + m.qtyMax, 0) >= quorum.targetQty && members.length >= quorum.minMembers;
}

// The coalition limit L (ARCHITECTURE §4): the highest bid price P at which everyone willing to pay
// at least P still makes quorum. Lowering the price only adds members, so the first P that works,
// scanning from the top, is the highest. Never stored, never sent to an LLM.
export function coalitionLimit(bids: readonly Bid[], quorum: Quorum): { limitCents: Cents; participants: string[] } | null {
  const prices = [...new Set(bids.map((b) => b.maxUnitPriceCents))].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  for (const price of prices) {
    const members = bids.filter((b) => b.maxUnitPriceCents >= price);
    if (meetsQuorum(members, quorum)) {
      return { limitCents: price, participants: members.map((m) => m.pledgeId).sort() };
    }
  }
  return null;
}
