import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addCents, cents, fromDollars, minCents, mulCents, toDollars } from "./money.ts";

const RUNS = { numRuns: 500 };
const arbCents = fc.bigInt({ min: 0n, max: 10n ** 15n }).map((v) => cents(v));

describe("cents", () => {
  it("accepts non-negative integers as bigint or number", () => {
    expect(cents(0)).toBe(0n);
    expect(cents(1234)).toBe(1234n);
    expect(cents(5n)).toBe(5n);
    expect(typeof cents(7)).toBe("bigint");
  });

  it("rejects negatives and non-integers with RangeError", () => {
    for (const bad of [-1, -1n, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => cents(bad), String(bad)).toThrow(RangeError);
    }
  });
});

describe("cents arithmetic is exact bigint arithmetic", () => {
  it("addCents is the exact sum", () => {
    fc.assert(
      fc.property(fc.array(arbCents, { minLength: 1, maxLength: 20 }), (values) => {
        expect(addCents(...values)).toBe(values.reduce((sum, v) => sum + v, 0n));
      }),
      RUNS,
    );
  });

  it("mulCents is unit × qty with no rounding drift, even for large amounts", () => {
    fc.assert(
      fc.property(arbCents, fc.nat({ max: 1_000_000 }), (unit, qty) => {
        expect(mulCents(unit, qty)).toBe(unit * BigInt(qty));
      }),
      RUNS,
    );
  });

  it("mulCents rejects a qty that is not a non-negative integer", () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() => mulCents(cents(100), bad), String(bad)).toThrow(RangeError);
    }
  });

  it("minCents returns the smaller value", () => {
    fc.assert(
      fc.property(arbCents, arbCents, (a, b) => {
        expect(minCents(a, b)).toBe(a < b ? a : b);
      }),
      RUNS,
    );
  });
});

describe("dollar strings", () => {
  it("formats with exactly two decimals", () => {
    expect(toDollars(cents(1234))).toBe("12.34");
    expect(toDollars(cents(5))).toBe("0.05");
    expect(toDollars(cents(0))).toBe("0.00");
  });

  it("toDollars then fromDollars round-trips every amount", () => {
    fc.assert(
      fc.property(arbCents, (value) => {
        const text = toDollars(value);
        expect(text).toMatch(/^(0|[1-9]\d*)\.\d{2}$/);
        expect(fromDollars(text)).toBe(value);
      }),
      RUNS,
    );
  });

  it("parses whole dollars and one-decimal amounts", () => {
    expect(fromDollars("12.34")).toBe(1234n);
    expect(fromDollars("12")).toBe(1200n);
    expect(fromDollars("12.3")).toBe(1230n);
    fc.assert(
      fc.property(fc.nat({ max: 10_000_000 }), fc.integer({ min: 0, max: 9 }), (dollars, dime) => {
        expect(fromDollars(`${dollars}`)).toBe(BigInt(dollars) * 100n);
        expect(fromDollars(`${dollars}.${dime}`)).toBe(BigInt(dollars) * 100n + BigInt(dime) * 10n);
      }),
      RUNS,
    );
  });

  it("rejects negatives, sub-cent precision, and non-numbers", () => {
    for (const bad of ["-1", "1.234", "abc", ""]) {
      expect(() => fromDollars(bad), JSON.stringify(bad)).toThrow();
    }
  });
});
