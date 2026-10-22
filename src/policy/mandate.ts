import { mulCents, type Cents } from "./money.ts";

// A member's signed commitment: the most they'll pay per unit, how much they want, and until when.
export type Mandate = { memberId: string; maxUnitPriceCents: Cents; qtyMin: number; qtyMax: number; deadlineAt: Date };

export type MandateError =
  | "qty_min_not_positive_integer"
  | "qty_max_below_min"
  | "qty_max_not_integer"
  | "price_not_positive"
  | "deadline_invalid";

export type MandateInput = { memberId: string; maxUnitPriceCents: bigint; qtyMin: number; qtyMax: number; deadlineAt: Date };

// Reports every broken rule, not just the first, so the intake UI can show them all at once.
export function validateMandate(input: MandateInput): { ok: true; mandate: Mandate } | { ok: false; errors: MandateError[] } {
  const errors: MandateError[] = [];
  const minOk = Number.isSafeInteger(input.qtyMin) && input.qtyMin > 0;
  const maxOk = Number.isSafeInteger(input.qtyMax);
  if (!minOk) errors.push("qty_min_not_positive_integer");
  if (!maxOk) errors.push("qty_max_not_integer");
  // Only comparable once both are integers; otherwise the integer errors already explain the input.
  if (Number.isSafeInteger(input.qtyMin) && maxOk && input.qtyMax < input.qtyMin) errors.push("qty_max_below_min");
  if (input.maxUnitPriceCents <= 0n) errors.push("price_not_positive");
  if (!(input.deadlineAt instanceof Date) || Number.isNaN(input.deadlineAt.getTime())) errors.push("deadline_invalid");
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    mandate: {
      memberId: input.memberId,
      maxUnitPriceCents: input.maxUnitPriceCents as Cents,
      qtyMin: input.qtyMin,
      qtyMax: input.qtyMax,
      deadlineAt: new Date(input.deadlineAt.getTime()),
    },
  };
}

// What the member's PayPal authorization is sized to: the ceiling price for the most they'd take.
export function maxExposure(m: Mandate): Cents {
  return mulCents(m.maxUnitPriceCents, m.qtyMax);
}
