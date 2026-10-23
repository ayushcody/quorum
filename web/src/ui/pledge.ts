// What the pledge page says in each state. Pure: the page decides when, this decides the words.

export type Failure = { code?: string; status?: number; network?: boolean };
export type FailureText = { title: string; message: string; retry: boolean };

const NOTHING_HELD = "Nothing was held or charged.";

const KNOWN: Record<string, FailureText> = {
  round_closed: { title: "This round just closed", message: `It stopped taking pledges before yours arrived. ${NOTHING_HELD}`, retry: false },
  round_not_found: { title: "We can't find this round", message: `The link may be old. ${NOTHING_HELD}`, retry: false },
  already_pledged: { title: "You've already pledged here", message: `This device already pledged to this round with different terms. ${NOTHING_HELD}`, retry: false },
  invalid_member: { title: "Check your details", message: `Your name or shop name couldn't be used. ${NOTHING_HELD}`, retry: false },
  paypal_pending: { title: "PayPal is taking a while", message: `PayPal didn't answer in time. ${NOTHING_HELD} Try again in a moment.`, retry: true },
  paypal_failed: { title: "PayPal couldn't place the hold", message: `PayPal turned the request down. ${NOTHING_HELD} You can try again.`, retry: true },
};

// Signing problems mean this browser's pledge didn't verify; a fresh attempt makes a fresh signature.
const SIGNING = new Set(["bad_key", "bad_signature", "invalid_mandate", "payload_mismatch", "malformed_payload"]);

export function describeFailure(f: Failure): FailureText {
  if (f.code && KNOWN[f.code]) return KNOWN[f.code]!;
  if (f.code && SIGNING.has(f.code)) return { title: "Your pledge didn't verify", message: `Quorum couldn't confirm your signed limit. ${NOTHING_HELD} Reload the page and try again.`, retry: true };
  // No JSON code and a gateway error: the API itself is down or unreachable (Vite's proxy, Render).
  if (f.network || (!f.code && f.status !== undefined && f.status >= 500)) {
    return { title: "Can't reach Quorum right now", message: `Check your connection; we'll keep trying. ${NOTHING_HELD}`, retry: true };
  }
  return { title: "Something went wrong", message: `${NOTHING_HELD} Please try again.`, retry: true };
}

export function availability(round: { status: string; pledgeDeadlineAt: string }, now: Date): { open: boolean; reason: string } {
  if (round.status === "open" && new Date(round.pledgeDeadlineAt) > now) return { open: true, reason: "" };
  const reason: Record<string, string> = {
    voided: "This round didn't reach its target, so every hold was released.",
    voiding: "This round didn't reach its target. Holds are being released.",
    settled: "This round settled at the group price.",
    settling: "This round hit its target and is being settled now.",
    fulfilled: "This round settled and was delivered.",
  };
  return { open: false, reason: reason[round.status] ?? "Agents are working out the group price for the shops that joined. Holds are charged only if it settles." };
}

// PayPal's honor period: the window in which a hold can be captured without reauthorizing (D2).
const HONOR_MS = 72 * 3_600_000;

export type Step = { key: "held" | "closes" | "decides" | "delivery"; title: string; when: string; state: "done" | "current" | "upcoming" };

export function receiptSteps(r: { authorizedAt: Date; pledgeDeadlineAt: string; deliveryBy: string; timeZone?: string }, now: Date): Step[] {
  const tz = r.timeZone ? { timeZone: r.timeZone } : {};
  const at = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...tz });
  // deliveryBy is a calendar date ("2026-11-01"): print it as written, whatever the viewer's zone.
  const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const closes = new Date(r.pledgeDeadlineAt);
  const decides = new Date(closes.getTime() + HONOR_MS);
  const steps: Omit<Step, "state">[] = [
    { key: "held", title: "Hold placed", when: at.format(r.authorizedAt) },
    { key: "closes", title: "Pledging closes", when: at.format(closes) },
    { key: "decides", title: "Group price charged, or hold released", when: `by ${at.format(decides)}` },
    { key: "delivery", title: "Delivery", when: `by ${day.format(new Date(`${r.deliveryBy.slice(0, 10)}T00:00:00Z`))}` },
  ];
  const ends = [r.authorizedAt, closes, decides];
  const firstOpen = ends.findIndex((d) => d > now);
  const current = firstOpen === -1 ? 3 : Math.max(firstOpen, 1);
  return steps.map((s, i) => ({ ...s, state: i < current ? "done" : i === current ? "current" : "upcoming" }));
}
