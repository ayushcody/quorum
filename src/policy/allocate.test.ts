import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { pledgeIdOf } from "../../test/policy-arbitraries.ts";
import { allocate, type Ask } from "./allocate.ts";

const RUNS = { numRuns: 500 };

const arbAsk: fc.Arbitrary<Ask> = fc
  .record({ pledgeId: fc.integer({ min: 0, max: 99 }).map(pledgeIdOf), qtyMin: fc.integer({ min: 1, max: 5 }), extra: fc.integer({ min: 0, max: 8 }) })
  .map(({ pledgeId, qtyMin, extra }) => ({ pledgeId, qtyMin, qtyMax: qtyMin + extra }));
const arbAsks = fc.uniqueArray(arbAsk, { selector: (a) => a.pledgeId, maxLength: 8 });

const sumMin = (asks: Ask[]) => asks.reduce((s, a) => s + a.qtyMin, 0);
const sumMax = (asks: Ask[]) => asks.reduce((s, a) => s + a.qtyMax, 0);

// Asks with a cap that is absent, generous, tight, or infeasible.
const arbCase = arbAsks.chain((asks) =>
  fc.tuple(
    fc.constant(asks),
    fc.oneof({ weight: 1, arbitrary: fc.constant(undefined) }, { weight: 3, arbitrary: fc.integer({ min: 0, max: sumMax(asks) + 3 }) }),
  ),
);

const feasible = (asks: Ask[], cap: number | undefined) => cap === undefined || sumMin(asks) <= cap;
const entries = (m: Map<string, number>) => [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

describe("allocate", () => {
  it("returns null exactly when Σ qtyMin exceeds the supply cap", () => {
    fc.assert(
      fc.property(arbCase, ([asks, cap]) => {
        expect(allocate(asks, cap) === null).toBe(!feasible(asks, cap));
      }),
      RUNS,
    );
  });

  it("gives every ask an integer qty within [qtyMin, qtyMax], keyed by every pledgeId", () => {
    fc.assert(
      fc.property(arbCase, ([asks, cap]) => {
        const result = allocate(asks, cap);
        if (result === null) return;
        expect([...result.keys()].sort()).toEqual(asks.map((a) => a.pledgeId).sort());
        for (const a of asks) {
          const qty = result.get(a.pledgeId) ?? Number.NaN;
          expect(Number.isInteger(qty), a.pledgeId).toBe(true);
          expect(qty).toBeGreaterThanOrEqual(a.qtyMin);
          expect(qty).toBeLessThanOrEqual(a.qtyMax);
        }
      }),
      RUNS,
    );
  });

  it("allocates Σ = min(supplyCap, Σ qtyMax), never above the cap", () => {
    fc.assert(
      fc.property(arbCase, ([asks, cap]) => {
        const result = allocate(asks, cap);
        if (result === null) return;
        const total = [...result.values()].reduce((s, q) => s + q, 0);
        expect(total).toBe(cap === undefined ? sumMax(asks) : Math.min(cap, sumMax(asks)));
      }),
      RUNS,
    );
  });

  it("gives everyone qtyMax when there is no cap or the cap covers Σ qtyMax", () => {
    fc.assert(
      fc.property(arbAsks, fc.option(fc.nat({ max: 10 }), { nil: undefined }), (asks, slack) => {
        const cap = slack === undefined ? undefined : sumMax(asks) + slack;
        const result = allocate(asks, cap);
        expect(result).not.toBeNull();
        if (result !== null) expect(entries(result)).toEqual(entries(new Map(asks.map((a) => [a.pledgeId, a.qtyMax]))));
      }),
      RUNS,
    );
  });

  it("cuts each ask within one unit of its exact share of (qtyMax − qtyMin)", () => {
    fc.assert(
      fc.property(arbCase, ([asks, cap]) => {
        if (cap === undefined || cap >= sumMax(asks) || cap < sumMin(asks)) return;
        const result = allocate(asks, cap);
        expect(result).not.toBeNull();
        if (result === null) return;
        const cut = sumMax(asks) - cap;
        const weight = asks.reduce((s, a) => s + (a.qtyMax - a.qtyMin), 0);
        for (const a of asks) {
          // exact share: qtyMax − cut × (qtyMax − qtyMin) / weight, compared in integers
          const ideal = weight * a.qtyMax - cut * (a.qtyMax - a.qtyMin);
          const qty = result.get(a.pledgeId) ?? Number.NaN;
          expect(Math.abs(weight * qty - ideal), a.pledgeId).toBeLessThan(weight);
        }
      }),
      RUNS,
    );
  });

  it("does not depend on input order (ties break by pledgeId)", () => {
    fc.assert(
      fc.property(
        arbCase.chain(([asks, cap]) => fc.tuple(fc.constant(asks), fc.shuffledSubarray(asks, { minLength: asks.length, maxLength: asks.length }), fc.constant(cap))),
        ([asks, shuffled, cap]) => {
          const a = allocate(asks, cap);
          const b = allocate(shuffled, cap);
          expect(a === null ? null : entries(a)).toEqual(b === null ? null : entries(b));
        },
      ),
      RUNS,
    );
  });
});
