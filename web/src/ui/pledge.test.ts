import { describe, expect, it } from "vitest";
import { availability, describeFailure, receiptSteps } from "./pledge.ts";

describe("describeFailure", () => {
  it("turns every server error code a member can hit into plain words", () => {
    for (const code of ["round_closed", "already_pledged", "invalid_member", "paypal_pending", "paypal_failed", "round_not_found", "bad_signature", "invalid_mandate"]) {
      const f = describeFailure({ code, status: 400 });
      expect(f.title, code).not.toMatch(/_/);
      expect(f.message, code).not.toContain(code);
    }
  });

  it("offers a retry only where trying again can work", () => {
    expect(describeFailure({ code: "paypal_pending", status: 503 }).retry).toBe(true);
    expect(describeFailure({ code: "paypal_failed", status: 502 }).retry).toBe(true);
    expect(describeFailure({ code: "round_closed", status: 409 }).retry).toBe(false);
    expect(describeFailure({ code: "already_pledged", status: 409 }).retry).toBe(false);
  });

  it("calls a dropped connection or a dead proxy 'can't reach Quorum', not a PayPal problem", () => {
    const offline = describeFailure({ network: true });
    expect(offline.title).toMatch(/reach Quorum/);
    expect(offline.retry).toBe(true);
    // Vite's proxy answers 5xx with no JSON error code when the API is down.
    expect(describeFailure({ status: 502 }).title).toBe(offline.title);
    expect(describeFailure({ status: 504 }).title).toBe(offline.title);
  });

  it("never claims money moved when something failed", () => {
    for (const input of [{ network: true }, { code: "paypal_failed", status: 502 }, { code: "whatever", status: 500 }]) {
      expect(describeFailure(input).message).toMatch(/nothing (was|has been) (held|charged)/i);
    }
  });
});

describe("availability", () => {
  const now = new Date("2026-10-23T12:00:00Z");
  it("is open only while the round is open and its deadline is ahead", () => {
    expect(availability({ status: "open", pledgeDeadlineAt: "2026-10-24T12:00:00Z" }, now).open).toBe(true);
    expect(availability({ status: "open", pledgeDeadlineAt: "2026-10-23T11:00:00Z" }, now).open).toBe(false);
    expect(availability({ status: "locked", pledgeDeadlineAt: "2026-10-24T12:00:00Z" }, now).open).toBe(false);
  });

  it("explains what a closed round means for money already held", () => {
    expect(availability({ status: "voided", pledgeDeadlineAt: "2026-10-20T00:00:00Z" }, now).reason).toMatch(/released/);
    expect(availability({ status: "settled", pledgeDeadlineAt: "2026-10-20T00:00:00Z" }, now).reason).toMatch(/settled/);
  });
});

describe("receiptSteps", () => {
  const base = { authorizedAt: new Date("2026-10-23T12:00:00Z"), pledgeDeadlineAt: "2026-10-25T10:00:00Z", deliveryBy: "2026-11-01", timeZone: "UTC" };

  it("dates every step: hold, close, settle-or-release (72 h honor period), delivery", () => {
    const steps = receiptSteps(base, new Date("2026-10-23T12:00:00Z"));
    expect(steps.map((s) => s.key)).toEqual(["held", "closes", "decides", "delivery"]);
    expect(steps.map((s) => s.when)).toEqual(["Oct 23, 12:00 PM", "Oct 25, 10:00 AM", "by Oct 28, 10:00 AM", "by Nov 1"]);
  });

  it("marks the hold done and the next deadline current", () => {
    const before = receiptSteps(base, new Date("2026-10-23T12:00:00Z"));
    expect(before.map((s) => s.state)).toEqual(["done", "current", "upcoming", "upcoming"]);
    const after = receiptSteps(base, new Date("2026-10-26T00:00:00Z"));
    expect(after.map((s) => s.state)).toEqual(["done", "done", "current", "upcoming"]);
  });

  it("shows delivery as a date, not shifted a day by the time zone", () => {
    const west = receiptSteps({ ...base, timeZone: "America/Los_Angeles" }, base.authorizedAt);
    expect(west.at(-1)!.when).toBe("by Nov 1");
  });
});
