import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { at, DAY } from "../../test/policy-arbitraries.ts";
import { maxExposure, validateMandate, type MandateError } from "./mandate.ts";

const RUNS = { numRuns: 500 };

type MandateInput = Parameters<typeof validateMandate>[0];

const arbValidInput: fc.Arbitrary<MandateInput> = fc
  .record({
    memberId: fc.string({ minLength: 1, maxLength: 12 }),
    maxUnitPriceCents: fc.bigInt({ min: 1n, max: 10n ** 9n }),
    qtyMin: fc.integer({ min: 1, max: 1_000 }),
    extra: fc.integer({ min: 0, max: 1_000 }),
    deadlineAt: fc.integer({ min: -30 * DAY, max: 30 * DAY }).map(at),
  })
  .map(({ extra, ...rest }) => ({ ...rest, qtyMax: rest.qtyMin + extra }));

// One rule broken on an otherwise valid input, keeping qtyMax ≥ qtyMin unless that is the broken rule.
const arbSingleViolation: fc.Arbitrary<{ input: MandateInput; error: MandateError }> = arbValidInput.chain((base) =>
  fc.oneof(
    fc
      .oneof(fc.integer({ min: -100, max: 0 }), fc.constant(base.qtyMin - 0.5))
      .map((qtyMin) => ({ input: { ...base, qtyMin }, error: "qty_min_not_positive_integer" as const })),
    fc
      .integer({ min: 1, max: 50 })
      .map((k) => ({ input: { ...base, qtyMax: base.qtyMin - k }, error: "qty_max_below_min" as const })),
    fc.constant({ input: { ...base, qtyMax: base.qtyMax + 0.5 }, error: "qty_max_not_integer" as const }),
    fc
      .bigInt({ min: -(10n ** 9n), max: 0n })
      .map((maxUnitPriceCents) => ({ input: { ...base, maxUnitPriceCents }, error: "price_not_positive" as const })),
    fc.constant({ input: { ...base, deadlineAt: new Date(Number.NaN) }, error: "deadline_invalid" as const }),
  ),
);

describe("validateMandate", () => {
  it("accepts every well-formed mandate and keeps its fields", () => {
    fc.assert(
      fc.property(arbValidInput, (input) => {
        const result = validateMandate(input);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.mandate.memberId).toBe(input.memberId);
        expect(result.mandate.maxUnitPriceCents).toBe(input.maxUnitPriceCents);
        expect(result.mandate.qtyMin).toBe(input.qtyMin);
        expect(result.mandate.qtyMax).toBe(input.qtyMax);
        expect(result.mandate.deadlineAt.getTime()).toBe(input.deadlineAt.getTime());
      }),
      RUNS,
    );
  });

  it("names the one broken rule when exactly one is broken", () => {
    fc.assert(
      fc.property(arbSingleViolation, ({ input, error }) => {
        expect(validateMandate(input)).toEqual({ ok: false, errors: [error] });
      }),
      RUNS,
    );
  });

  it("reports every broken rule, not just the first", () => {
    const deadlineAt = new Date(Number.NaN);
    const many = validateMandate({ memberId: "m-1", maxUnitPriceCents: -5n, qtyMin: 3, qtyMax: 2, deadlineAt });
    expect(many.ok).toBe(false);
    if (!many.ok) expect([...many.errors].sort()).toEqual(["deadline_invalid", "price_not_positive", "qty_max_below_min"]);

    const qty = validateMandate({ memberId: "m-1", maxUnitPriceCents: 100n, qtyMin: 0, qtyMax: 2.5, deadlineAt: at(DAY) });
    expect(qty.ok).toBe(false);
    if (!qty.ok) expect([...qty.errors].sort()).toEqual(["qty_max_not_integer", "qty_min_not_positive_integer"]);
  });
});

describe("maxExposure", () => {
  it("is the ceiling price × qtyMax, exactly", () => {
    fc.assert(
      fc.property(arbValidInput, (input) => {
        const result = validateMandate(input);
        if (!result.ok) throw new Error(`valid input rejected: ${result.errors.join(",")}`);
        expect(maxExposure(result.mandate)).toBe(input.maxUnitPriceCents * BigInt(input.qtyMax));
      }),
      RUNS,
    );
  });
});
