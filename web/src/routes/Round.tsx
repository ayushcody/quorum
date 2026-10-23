import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { signMandate, toMandatePayload, type SigningKey } from "../../../src/pledge/mandate-sign.ts";
import { createPayPalSession } from "../paypal/v6.ts";
import { countdown, holdCents, parseDollars, progress, usd } from "../ui/format.ts";
import { Icon, Shell } from "../ui/kit.tsx";
import { api, failureOf, useNow, usePolling, type RoundSummary } from "../ui/live.ts";
import { availability, describeFailure, receiptSteps, type FailureText } from "../ui/pledge.ts";

// /round/:id: the page a member (or a judge, on a phone) opens to pledge. The mandate is signed in
// the browser (WebCrypto P-256), the server creates the AUTHORIZE order, and the buyer approves in
// PayPal's v6 popup. No money moves here: it's a hold, captured only if the round settles.

type Config = { paypalClientId: string; paypalSdkUrl: string };
type Phase =
  | { kind: "form"; notice?: string }
  | { kind: "approving" }
  | { kind: "authorizing" }
  | { kind: "done"; authorizationId: string; authorizedAt: Date; holdCents: bigint; maxCents: bigint; qtyMax: number }
  | { kind: "error"; failure: FailureText };
type Form = { displayName: string; businessName: string; maxDollars: string; qtyMin: string; qtyMax: string };
type Problems = Partial<Record<keyof Form, string>>;

const HONOR_MS = 72 * 3_600_000;
const POLL_MS = 5_000;

function validate(f: Form): Problems {
  const p: Problems = {};
  if (!f.displayName.trim()) p.displayName = "Add your name";
  if (!f.businessName.trim()) p.businessName = "Add your shop's name";
  if (parseDollars(f.maxDollars) === undefined) p.maxDollars = "A price like 14.00";
  const min = Number(f.qtyMin);
  const max = Number(f.qtyMax);
  if (!Number.isInteger(min) || min < 1) p.qtyMin = "Whole number, 1 or more";
  if (!Number.isInteger(max) || max < 1) p.qtyMax = "Whole number, 1 or more";
  else if (Number.isInteger(min) && max < min) p.qtyMax = "At least your minimum";
  return p;
}

function Field(props: { id: keyof Form; label: string; value: string; onChange: (v: string) => void; problem?: string | undefined; show: boolean; prefix?: string; suffix?: string; inputMode?: "text" | "decimal" | "numeric"; placeholder?: string; autoComplete?: string; disabled?: boolean }) {
  const invalid = props.show && props.problem;
  return (
    <div className="field">
      <label htmlFor={props.id}>{props.label}</label>
      <div className={`input ${invalid ? "invalid" : ""}`}>
        {props.prefix && (
          <span className="affix" aria-hidden="true">
            {props.prefix}
          </span>
        )}
        <input
          id={props.id}
          value={props.value}
          inputMode={props.inputMode ?? "text"}
          placeholder={props.placeholder}
          autoComplete={props.autoComplete ?? "off"}
          required
          disabled={props.disabled}
          aria-invalid={Boolean(invalid)}
          aria-describedby={invalid ? `${props.id}-error` : undefined}
          onChange={(e) => props.onChange(e.target.value)}
        />
        {props.suffix && (
          <span className="affix end" aria-hidden="true">
            {props.suffix}
          </span>
        )}
      </div>
      {invalid && (
        <span className="error-text" id={`${props.id}-error`}>
          {props.problem}
        </span>
      )}
    </div>
  );
}

function Problem({ failure, onRetry }: { failure: FailureText; onRetry?: () => void }) {
  return (
    <div className="status error" role="alert">
      <div style={{ flex: 1 }}>
        <strong>{failure.title}</strong>
        <div style={{ fontWeight: 500 }}>{failure.message}</div>
      </div>
      {failure.retry && onRetry && (
        <button type="button" className="link-btn" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

function PageMessage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Shell>
      <main id="main" className="container" style={{ paddingTop: 64, paddingBottom: 64 }}>
        <div className="card stack rise" style={{ padding: 28, maxWidth: 520 }}>
          <h1 style={{ fontSize: 26 }}>{title}</h1>
          {children}
        </div>
      </main>
    </Shell>
  );
}

export function RoundPage({ roundId }: { roundId: string }) {
  const live = usePolling<RoundSummary>(`/api/rounds/${roundId}`, POLL_MS);
  const round = live.data;
  const [config, setConfig] = useState<Config>();
  const [sdkFailure, setSdkFailure] = useState<FailureText>();
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [form, setForm] = useState<Form>({ displayName: "", businessName: "", maxDollars: "14.00", qtyMin: "10", qtyMax: "30" });
  const [showProblems, setShowProblems] = useState(false);
  const [buttonReady, setButtonReady] = useState(false);
  const now = useNow(15_000);
  const formRef = useRef(form);
  formRef.current = form;
  const roundRef = useRef(round);
  roundRef.current = round;
  const buttonHost = useRef<HTMLDivElement>(null);
  // This browser's signing key for the session; the private key never leaves it.
  const identity = useRef<{ memberId: string; privateKey: SigningKey }>(undefined);
  const pledgeId = useRef<string>(undefined);

  const problems = useMemo(() => validate(form), [form]);
  const hold = holdCents(parseDollars(form.maxDollars), Number(form.qtyMax));
  const open = round ? availability(round, now) : undefined;
  const busy = phase.kind === "approving" || phase.kind === "authorizing";

  useEffect(() => {
    if (round) document.title = `${round.title} · Quorum`;
  }, [round?.title]);

  useEffect(() => {
    api<Config>("/api/config")
      .then(setConfig)
      .catch((e) => setSdkFailure(describeFailure(failureOf(e))));
  }, []);

  // Build the PayPal button once per open round. Keyed on id and open/closed only: polling replaces
  // `round` every few seconds, and rebuilding the button would kill a popup that's mid-approval.
  const roundOpen = open?.open === true;
  useEffect(() => {
    if (!config || !roundOpen || !buttonHost.current) return;
    let cancelled = false;
    const host = buttonHost.current;

    // Sign the mandate and create the order inside the click, so the popup keeps the user gesture.
    const createOrder = async (): Promise<{ orderId: string }> => {
      const f = formRef.current;
      const r = roundRef.current!;
      if (!identity.current) {
        const pair = await globalThis.crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
        const publicKeyJwk = await globalThis.crypto.subtle.exportKey("jwk", pair.publicKey);
        const { memberId } = await api<{ memberId: string }>("/api/members", {
          method: "POST",
          body: JSON.stringify({ displayName: f.displayName.trim(), businessName: f.businessName.trim(), publicKeyJwk }),
        });
        identity.current = { memberId, privateKey: pair.privateKey };
      }
      const payload = toMandatePayload({
        roundId: r.id,
        memberId: identity.current.memberId,
        maxUnitPriceCents: parseDollars(f.maxDollars)!,
        qtyMin: Number(f.qtyMin),
        qtyMax: Number(f.qtyMax),
        // The mandate must still hold when the round settles: through the hold's honor period.
        deadlineAt: new Date(new Date(r.pledgeDeadlineAt).getTime() + HONOR_MS),
      });
      const signature = await signMandate(payload, identity.current.privateKey);
      const pledge = await api<{ pledgeId: string; orderId: string }>(`/api/rounds/${r.id}/pledges`, {
        method: "POST",
        body: JSON.stringify({ memberId: identity.current.memberId, payload, signature }),
      });
      pledgeId.current = pledge.pledgeId;
      return { orderId: pledge.orderId };
    };

    createPayPalSession(config, {
      onApprove: async () => {
        setPhase({ kind: "authorizing" });
        try {
          const { authorizationId } = await api<{ authorizationId: string }>(`/api/pledges/${pledgeId.current}/authorize`, { method: "POST", body: "{}" });
          const f = formRef.current;
          const max = parseDollars(f.maxDollars)!;
          setPhase({ kind: "done", authorizationId, authorizedAt: new Date(), maxCents: max, qtyMax: Number(f.qtyMax), holdCents: holdCents(max, Number(f.qtyMax))! });
        } catch (e) {
          setPhase({ kind: "error", failure: describeFailure(failureOf(e)) });
        }
      },
      onCancel: () => setPhase({ kind: "form", notice: "You closed PayPal before approving. Nothing was held." }),
      onError: () => setPhase({ kind: "error", failure: describeFailure({ code: "paypal_failed" }) }),
    })
      .then((session) => {
        if (cancelled) return;
        if (!session) return setSdkFailure({ title: "PayPal isn't available here", message: "This browser can't show PayPal checkout. Nothing was held or charged.", retry: false });
        const button = document.createElement("paypal-button");
        button.setAttribute("type", "pay");
        button.addEventListener("click", () => {
          // Check the form before PayPal opens: a popup for an order that can't be created is a dead end.
          const first = Object.keys(validate(formRef.current))[0];
          if (first) {
            setShowProblems(true);
            document.getElementById(first)?.focus();
            return;
          }
          setPhase({ kind: "approving" });
          const order = createOrder();
          order.catch((e) => setPhase({ kind: "error", failure: describeFailure(failureOf(e)) }));
          void session.start({ presentationMode: "auto" }, order);
        });
        host.replaceChildren(button);
        setButtonReady(true);
      })
      .catch(() => setSdkFailure({ title: "PayPal didn't load", message: "Check your connection and reload the page. Nothing was held or charged.", retry: true }));
    return () => {
      cancelled = true;
      setButtonReady(false);
      host.replaceChildren();
    };
  }, [config, roundOpen]);

  const set = (key: keyof Form) => (v: string) => setForm((f) => ({ ...f, [key]: v }));

  if (!round) {
    if (!live.failure) {
      return (
        <Shell>
          <main id="main" className="container" aria-busy="true" style={{ display: "grid", placeItems: "center", minHeight: "60vh" }}>
            <span className="spinner" aria-label="Loading the round" />
          </main>
        </Shell>
      );
    }
    const f = describeFailure(live.failure);
    return (
      <PageMessage title={live.failure.code === "round_not_found" ? "We can't find this round" : f.title}>
        <p className="muted" style={{ margin: 0 }}>
          {live.failure.code === "round_not_found" ? "The link may be old, or the round was removed." : "We'll keep trying in the background; this page fills in as soon as Quorum answers."}
        </p>
        <a className="btn btn-ghost" href="/">
          Back to Quorum
        </a>
      </PageMessage>
    );
  }

  const p = progress(round.progress.pledgedQty, round.targetQty);
  const left = countdown(new Date(round.pledgeDeadlineAt), now);
  const unit = round.unit;
  const shops = Math.max(round.minMembers, round.progress.members);

  return (
    <Shell>
      <main id="main" className="container pledge-layout">
        <section className="stack pledge-main" aria-labelledby="round-title">
          <div className="round-head">
            <a href="/" className="back-link">
              <span aria-hidden="true">←</span> All rounds
            </a>
            <h1 id="round-title">{round.title}</h1>
            <div className="meta">
              <span>
                <Icon name="clock" size={15} /> <span className="num">{left.label}</span>
              </span>
              <span>
                <Icon name="users" size={15} /> Needs {round.minMembers}+ shops
              </span>
              <span>
                <Icon name="bean" size={15} /> Target {round.targetQty} {unit}
              </span>
              {round.isDemo && <span className="badge brand">Demo round</span>}
            </div>
          </div>

          <div className="card progress-card rise">
            <div className="progress-figures">
              <div>
                <b className="num">{round.progress.pledgedQty}</b>
                <span className="muted" style={{ fontWeight: 600 }}>
                  {" "}
                  / {round.targetQty} {unit} pledged
                </span>
              </div>
              <span className={`badge ${p.reached ? "ok" : "brand"}`}>{p.reached ? "Target reached" : `${p.percent}%`}</span>
            </div>
            <div
              className={`meter ${p.reached ? "reached" : ""}`}
              role="progressbar"
              aria-valuenow={p.barPercent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuetext={`${round.progress.pledgedQty} of ${round.targetQty} ${unit} pledged`}
              aria-label="Pledged toward the target"
            >
              <span style={{ width: `${Math.max(p.barPercent, 2)}%` }} />
            </div>
            <div className="progress-foot">
              <div className="members-dots" role="img" aria-label={`${round.progress.members} of ${round.minMembers} shops needed have pledged`}>
                {Array.from({ length: shops }, (_, i) => (
                  <i key={i} className={i < round.progress.members ? "on" : ""} />
                ))}
                <span className="muted" aria-hidden="true">
                  {round.progress.members} of {round.minMembers} shops in
                </span>
              </div>
              <span className={`live-pill ${live.stale ? "stale" : ""}`}>
                <span className="pulse" aria-hidden="true" />
                {live.stale ? "Reconnecting…" : "Live"}
              </span>
            </div>
            {/* Announce new pledges to screen readers once, not every poll. */}
            <span className="sr-only" aria-live="polite">
              {round.progress.members > 0 ? `${round.progress.members} shops have pledged ${round.progress.pledgedQty} ${unit}.` : ""}
            </span>
          </div>
        </section>

        <aside className="pledge-panel" aria-label="Pledge">
          {phase.kind === "done" ? (
            <Receipt phase={phase} round={round} now={now} />
          ) : !open?.open ? (
            <div className="card stack closed-card rise">
              <div className="closed-icon">
                <Icon name="clock" size={26} />
              </div>
              <h2>Pledging has closed</h2>
              <p className="muted" style={{ margin: 0 }}>
                {open?.reason}
              </p>
              <a className="btn btn-ghost" href="/">
                See open rounds
              </a>
            </div>
          ) : (
            <div className="card">
              <div className="panel-title">
                <h2>Join this round</h2>
                <span className="muted" style={{ fontSize: 13, fontWeight: 600 }}>
                  <Icon name="lock" size={13} /> Signed on this device
                </span>
              </div>
              <fieldset className="stack" style={{ gap: 14 }} disabled={busy}>
                <legend className="sr-only">Your pledge</legend>
                <div className="two">
                  <Field id="displayName" label="Your name" value={form.displayName} onChange={set("displayName")} problem={problems.displayName} show={showProblems} placeholder="Maya" autoComplete="name" />
                  <Field id="businessName" label="Shop" value={form.businessName} onChange={set("businessName")} problem={problems.businessName} show={showProblems} placeholder="Maya's Café" autoComplete="organization" />
                </div>
                <Field id="maxDollars" label={`Most you'll pay per ${unit}`} value={form.maxDollars} onChange={set("maxDollars")} problem={problems.maxDollars} show={showProblems} prefix="$" suffix={`/ ${unit}`} inputMode="decimal" />
                <div className="two">
                  <Field id="qtyMin" label={`At least (${unit})`} value={form.qtyMin} onChange={set("qtyMin")} problem={problems.qtyMin} show={showProblems} suffix={unit} inputMode="numeric" />
                  <Field id="qtyMax" label={`At most (${unit})`} value={form.qtyMax} onChange={set("qtyMax")} problem={problems.qtyMax} show={showProblems} suffix={unit} inputMode="numeric" />
                </div>
              </fieldset>

              <div className="summary">
                <div className="hold">
                  <span style={{ fontWeight: 700 }}>PayPal will hold</span>
                  <b className="num" aria-live="polite">
                    {hold !== undefined ? usd(hold) : "—"}
                  </b>
                </div>
                <p>Your maximum, reserved and not charged. If the round settles, you pay the final group price for your share; if not, it's all released.</p>
              </div>

              {sdkFailure ? (
                <Problem failure={sdkFailure} onRetry={() => window.location.reload()} />
              ) : (
                <div ref={buttonHost} className={`paypal-slot ${buttonReady ? "" : "loading"}`} aria-busy={!buttonReady} aria-label={buttonReady ? undefined : "Loading PayPal"} />
              )}

              {phase.kind === "form" && phase.notice && (
                <div className="status" role="status">
                  <Icon name="lock" size={16} /> {phase.notice}
                </div>
              )}
              {phase.kind === "approving" && (
                <div className="status" role="status">
                  <span className="spinner" aria-hidden="true" /> <span style={{ flex: 1 }}>Finish in the PayPal window…</span>
                  <button type="button" className="link-btn" onClick={() => setPhase({ kind: "form" })}>
                    Start over
                  </button>
                </div>
              )}
              {phase.kind === "authorizing" && (
                <div className="status" role="status">
                  <span className="spinner" aria-hidden="true" /> Securing your hold with PayPal…
                </div>
              )}
              {phase.kind === "error" && <Problem failure={phase.failure} onRetry={() => setPhase({ kind: "form" })} />}

              <div className="fineprint">
                <Icon name="shield" size={16} />
                <span>Your limit is signed on this device and checked by Quorum before PayPal is asked for anything. Sandbox: no real money moves.</span>
              </div>
            </div>
          )}
        </aside>

        <section className="card pledge-how" style={{ padding: 24 }} aria-labelledby="how-title">
          <h2 id="how-title" style={{ fontSize: 18, marginBottom: 18 }}>
            What happens to your money
          </h2>
          <ol className="timeline">
            <li>
              <span className="dot">
                <Icon name="lock" size={18} />
              </span>
              <div>
                <h3>A hold, not a charge</h3>
                <p>PayPal reserves your maximum. Nothing leaves your account yet.</p>
              </div>
            </li>
            <li>
              <span className="dot">
                <Icon name="scale" size={18} />
              </span>
              <div>
                <h3>Agents negotiate for the group</h3>
                <p>The price can only land at or below the ceiling you signed.</p>
              </div>
            </li>
            <li>
              <span className="dot ok">
                <Icon name="check" size={18} />
              </span>
              <div>
                <h3>Settle or release</h3>
                <p>Target hit: you pay the final group price for your share. Target missed: the hold is released in full.</p>
              </div>
            </li>
          </ol>
        </section>
      </main>
    </Shell>
  );
}

function Receipt({ phase, round, now }: { phase: Extract<Phase, { kind: "done" }>; round: RoundSummary; now: Date }) {
  const heading = useRef<HTMLHeadingElement>(null);
  // Move focus to the result so keyboard and screen-reader users land on it after PayPal closes.
  useEffect(() => heading.current?.focus(), []);
  const steps = receiptSteps({ authorizedAt: phase.authorizedAt, pledgeDeadlineAt: round.pledgeDeadlineAt, deliveryBy: round.deliveryBy }, now);
  return (
    <div className="card success rise" role="status">
      <div className="tick" aria-hidden="true">
        <Icon name="check" size={34} />
      </div>
      <h2 ref={heading} tabIndex={-1}>
        You're in.
      </h2>
      <p className="muted" style={{ margin: 0 }}>
        PayPal is holding {usd(phase.holdCents)}. You'll pay the final group price for your share, and only if the round settles.
      </p>
      <dl>
        <dt>Your ceiling</dt>
        <dd className="num">
          {usd(phase.maxCents)} / {round.unit}
        </dd>
        <dt>Up to</dt>
        <dd className="num">
          {phase.qtyMax} {round.unit}
        </dd>
        <dt>Held now</dt>
        <dd className="num">{usd(phase.holdCents)}</dd>
        <dt>Authorization</dt>
        <dd className="num" style={{ fontSize: 13 }}>
          {phase.authorizationId}
        </dd>
      </dl>
      <h3 className="receipt-title">What happens next</h3>
      <ol className="receipt-steps">
        {steps.map((s) => (
          <li key={s.key} className={s.state} aria-current={s.state === "current" ? "step" : undefined}>
            <span className="mark" aria-hidden="true">
              {s.state === "done" ? <Icon name="check" size={14} /> : null}
            </span>
            <div>
              <b>{s.title}</b>
              <span className="num">{s.when}</span>
            </div>
          </li>
        ))}
      </ol>
      <a className="btn btn-ghost" href="/" style={{ marginTop: 20, width: "100%" }}>
        Back to Quorum
      </a>
    </div>
  );
}
