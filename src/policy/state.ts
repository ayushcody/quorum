// Legal states and transitions (ARCHITECTURE §6). The DB schema's CHECK constraints use these lists.

export const ROUND_STATES = [
  "draft", "open", "locked", "settling", "settled", "invoiced", "paid_out", "fulfilled",
  "voiding", "voided", "unwinding", "failed",
] as const;
export const PLEDGE_STATES = [
  "order_pending", "order_created", "authorized", "reauthorizing", "capture_pending", "captured",
  "void_pending", "voided", "refund_pending", "refunded", "abandoned",
] as const;
export const AUTHORIZATION_STATES = ["created", "captured", "voided", "expired", "denied", "reauthorized"] as const;

export type RoundStatus = (typeof ROUND_STATES)[number];
export type PledgeStatus = (typeof PLEDGE_STATES)[number];
export type AuthorizationStatus = (typeof AUTHORIZATION_STATES)[number];

const ROUND_EDGES: Record<RoundStatus, readonly RoundStatus[]> = {
  draft: ["open"],
  open: ["locked", "voiding"],
  locked: ["settling", "voiding"],
  settling: ["settled", "unwinding"],
  settled: ["invoiced"],
  invoiced: ["paid_out"],
  paid_out: ["fulfilled"],
  fulfilled: [],
  voiding: ["voided"],
  voided: [],
  unwinding: ["failed"],
  failed: [],
};

const PLEDGE_EDGES: Record<PledgeStatus, readonly PledgeStatus[]> = {
  order_pending: ["order_created", "abandoned"],
  order_created: ["authorized", "abandoned"],
  authorized: ["reauthorizing", "capture_pending", "void_pending"],
  reauthorizing: ["authorized", "void_pending"],
  capture_pending: ["captured", "void_pending"],
  captured: ["refund_pending"],
  void_pending: ["voided"],
  voided: [],
  refund_pending: ["refunded"],
  refunded: [],
  abandoned: [],
};

export function canTransitionRound(from: RoundStatus, to: RoundStatus): boolean {
  return ROUND_EDGES[from].includes(to);
}

export function canTransitionPledge(from: PledgeStatus, to: PledgeStatus): boolean {
  return PLEDGE_EDGES[from].includes(to);
}
