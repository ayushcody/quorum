// Outbox vocabularies (ARCHITECTURE §5). db/schema.ts builds its CHECK constraints from these.

export const OP_KINDS = [
  "create_order", "authorize_order", "client_token", "get_order", "get_authorization", "get_capture",
  "capture", "void", "reauthorize", "refund", "payout", "get_payout",
] as const;
export const OP_STATES = ["pending", "in_flight", "succeeded", "failed_retryable", "failed_terminal", "unknown"] as const;

export type OpKind = (typeof OP_KINDS)[number];
export type OpState = (typeof OP_STATES)[number];

// Writes whose effect a GET can confirm; an ambiguous outcome on these is settled by reading, not resending.
export const OBSERVABLE_WRITES = ["capture", "void", "authorize_order", "refund"] as const;
export type ObservableWrite = (typeof OBSERVABLE_WRITES)[number];
export const READ_KINDS = ["get_order", "get_authorization", "get_capture", "get_payout", "client_token"] as const;

export const isObservableWrite = (kind: OpKind): kind is ObservableWrite => (OBSERVABLE_WRITES as readonly string[]).includes(kind);
export const isRead = (kind: OpKind): boolean => (READ_KINDS as readonly string[]).includes(kind);
