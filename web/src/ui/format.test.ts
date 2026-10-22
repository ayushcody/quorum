import { describe, expect, it } from "vitest";
import { countdown, holdCents, parseDollars, progress, usd } from "./format.ts";

describe("usd", () => {
  it("formats cents as US dollars with thousands separators", () => {
    expect(usd(42_000n)).toBe("$420.00");
    expect(usd(5)).toBe("$0.05");
    expect(usd(123_456_789n)).toBe("$1,234,567.89");
  });
});

describe("parseDollars", () => {
  it("accepts what people type and returns cents, or undefined", () => {
    expect(parseDollars("14")).toBe(1_400n);
    expect(parseDollars("14.5")).toBe(1_450n);
    expect(parseDollars(" $14.05 ")).toBe(1_405n);
    for (const bad of ["", "abc", "-3", "1.234", "0", "0.00"]) expect(parseDollars(bad), bad).toBeUndefined();
  });
});

describe("holdCents", () => {
  it("is the ceiling price times the most you'd take, exactly", () => {
    expect(holdCents(1_400n, 30)).toBe(42_000n);
    expect(holdCents(undefined, 30)).toBeUndefined();
    expect(holdCents(1_400n, Number.NaN)).toBeUndefined();
  });
});

describe("progress", () => {
  it("reports percent toward the target, capped for the bar but not for the label", () => {
    expect(progress(50, 200)).toEqual({ percent: 25, barPercent: 25, reached: false });
    expect(progress(260, 200)).toEqual({ percent: 130, barPercent: 100, reached: true });
    expect(progress(0, 0)).toEqual({ percent: 0, barPercent: 0, reached: false });
  });
});

describe("countdown", () => {
  const now = new Date("2026-10-23T12:00:00Z");
  it("says how long is left, in friendly units", () => {
    expect(countdown(new Date("2026-10-24T16:30:00Z"), now)).toEqual({ closed: false, label: "1d 4h left" });
    expect(countdown(new Date("2026-10-23T15:05:00Z"), now)).toEqual({ closed: false, label: "3h 5m left" });
    expect(countdown(new Date("2026-10-23T12:00:40Z"), now)).toEqual({ closed: false, label: "under a minute left" });
    expect(countdown(new Date("2026-10-23T11:59:00Z"), now)).toEqual({ closed: true, label: "Pledging closed" });
  });
});
