import { useEffect, useMemo, useRef, useState } from "react";
import { signMandate, toMandatePayload, type SigningKey } from "../../../src/pledge/mandate-sign.ts";
import { createPayPalSession } from "../paypal/v6.ts";
import { countdown, holdCents, parseDollars, progress, usd } from "../ui/format.ts";
import { Icon, Shell } from "../ui/kit.tsx";
import { useNow, type RoundSummary } from "./Home.tsx";

// /round/:id: the page a member (or a judge, on a phone) opens to pledge. The mandate is signed in
// the browser (WebCrypto P-256), the server creates the AUTHORIZE order, and the buyer approves in
// PayPal's v6 popup. No money moves here: it's a hold, captured only if the round settles.

type Config = { paypalClientId: string; paypalSdkUrl: string };
type Phase =
  | { kind: "form" }
  | { kind: "approving" }
  | { kind: "authorizing" }
  | { kind: "done"; authorizationId: string; holdCents: bigint; maxCents: bigint; qtyMax: number }
  | { kind: "error"; message: string };
type Form = { displayName: string; businessName: string; maxDollars: string; qtyMin: string; qtyMax: string };
type Problems = Partial<Record<keyof Form, string>>;

const HONOR_MS = 72 * 3_600_000;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(friendly(body.error ?? `HTTP ${res.status}`));
  return body;
}

function friendly(code: string): string {
  const messages: Record<string, string> = {
    round_closed: "This round has stopped taking pledges.",
    already_pledged: "You've already pledged to this round with different terms.",
    invalid_member: "Please check your name and business.",
    paypal_pending: "PayPal is slow to answer. Please try again in a moment.",
    paypal_failed: "PayPal couldn't set up the hold. Please try again.",
  };
  return messages[code] ?? `Something went wrong (${code}).`;
}

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

function Field(props: { id: keyof Form; label: string; value: string; onChange: (v: string) => void; problem?: string | undefined; show: boolean; prefix?: string; suffix?: string; inputMode?: "text" | "decimal" | "numeric"; placeholder?: string; autoComplete?: string }) {
  const invalid = props.show && props.problem;
  return (
    <div className="field">
      <label htmlFor={props.id}>{props.label}</label>
      <div className={`input ${invalid ? "invalid" : ""}`}>
        {props.prefix && <span className="affix">{props.prefix}</span>}
        <input
          id={props.id}
          value={props.value}
          inputMode={props.inputMode ?? "text"}
          placeholder={props.placeholder}
          autoComplete={props.autoComplete}
          aria-invalid={Boolean(invalid)}
          aria-describedby={invalid ? `${props.id}-error` : undefined}
          onChange={(e) => props.onChange(e.target.value)}
        />
        {props.suffix && <span className="affix end">{props.suffix}</span>}
      </div>
      {invalid && (
        <span className="error-text" id={`${props.id}-error`}>
          {props.problem}
        </span>
      )}
    </div>
  );
}

export function RoundPage({ roundId }: { roundId: string }) {
  const [config, setConfig] = useState<Config>();
  const [round, setRound] = useState<RoundSummary>();
  const [loadError, setLoadError] = useState<string>();
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [form, setForm] = useState<Form>({ displayName: "", businessName: "", maxDollars: "14.00", qtyMin: "10", qtyMax: "30" });
  const [showProblems, setShowProblems] = useState(false);
  const [buttonReady, setButtonReady] = useState(false);
  const now = useNow();
  const formRef = useRef(form);
  formRef.current = form;
  const buttonHost = useRef<HTMLDivElement>(null);
  // This browser's signing key for the session; the private key never leaves it.
  const identity = useRef<{ memberId: string; privateKey: SigningKey }>(undefined);
  const pledgeId = useRef<string>(undefined);

  const problems = useMemo(() => validate(form), [form]);
  const maxCents = parseDollars(form.maxDollars);
  const hold = holdCents(maxCents, Number(form.qtyMax));

  useEffect(() => {
    Promise.all([api<Config>("/api/config"), api<RoundSummary>(`/api/rounds/${roundId}`)])
      .then(([c, r]) => {
        setConfig(c);
        setRound(r);
      })
      .catch((e: Error) => setLoadError(e.message));
  }, [roundId]);

  useEffect(() => {
    if (!config || !round || !buttonHost.current) return;
    let cancelled = false;
    const host = buttonHost.current;

    // Sign the mandate and create the order inside the click, so the popup keeps the user gesture.
    const createOrder = async (): Promise<{ orderId: string }> => {
      const f = formRef.current;
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
        roundId: round.id,
        memberId: identity.current.memberId,
        maxUnitPriceCents: parseDollars(f.maxDollars)!,
        qtyMin: Number(f.qtyMin),
        qtyMax: Number(f.qtyMax),
        // The mandate must still hold when the round settles: through the hold's honor period.
        deadlineAt: new Date(new Date(round.pledgeDeadlineAt).getTime() + HONOR_MS),
      });
      const signature = await signMandate(payload, identity.current.privateKey);
      const pledge = await api<{ pledgeId: string; orderId: string }>(`/api/rounds/${round.id}/pledges`, {
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
          setPhase({ kind: "done", authorizationId, maxCents: max, qtyMax: Number(f.qtyMax), holdCents: holdCents(max, Number(f.qtyMax))! });
        } catch (e) {
          setPhase({ kind: "error", message: (e as Error).message });
        }
      },
      onCancel: () => setPhase({ kind: "form" }),
      onError: () => setPhase({ kind: "error", message: "PayPal couldn't finish. Nothing was charged; please try again." }),
    })
      .then((session) => {
        if (cancelled) return;
        if (!session) return setLoadError("PayPal isn't available in this browser.");
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
          order.catch((e: Error) => setPhase({ kind: "error", message: e.message }));
          void session.start({ presentationMode: "auto" }, order);
        });
        host.replaceChildren(button);
        setButtonReady(true);
      })
      .catch(() => setLoadError("PayPal didn't load. Check your connection and refresh."));
    return () => {
      cancelled = true;
      host.replaceChildren();
    };
  }, [config, round]);

  const set = (key: keyof Form) => (v: string) => setForm((f) => ({ ...f, [key]: v }));

  if (loadError && !round) {
    return (
      <Shell>
        <main className="container" style={{ padding: "64px 20px" }}>
          <div className="card" style={{ padding: 28, maxWidth: 520 }}>
            <h1 style={{ fontSize: 26 }}>We couldn't open this round</h1>
            <p className="muted">{loadError}</p>
            <a className="btn btn-ghost" href="/">
              Back to Quorum
            </a>
          </div>
        </main>
      </Shell>
    );
  }

  const p = round ? progress(round.progress.pledgedQty, round.targetQty) : undefined;
  const left = round ? countdown(new Date(round.pledgeDeadlineAt), now) : undefined;
  const unit = round?.unit ?? "unit";

  return (
    <Shell>
      <main className="container pledge-layout">
        <section className="stack pledge-main" aria-label="Round details">
          <div className="round-head">
            <a href="/" className="muted" style={{ fontSize: 14, fontWeight: 600 }}>
              ← All rounds
            </a>
            <h1>{round?.title ?? "Loading round…"}</h1>
            {round && left && (
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
            )}
          </div>

          {round && p && (
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
              <div className={`meter ${p.reached ? "reached" : ""}`} role="progressbar" aria-valuenow={p.percent} aria-valuemin={0} aria-valuemax={100} aria-label="Quantity pledged toward the target">
                <span style={{ width: `${Math.max(p.barPercent, 2)}%` }} />
              </div>
              <div className="members-dots" aria-label={`${round.progress.members} of ${round.minMembers} shops have pledged`}>
                {Array.from({ length: Math.max(round.minMembers, round.progress.members) }, (_, i) => (
                  <i key={i} className={i < round.progress.members ? "on" : ""} />
                ))}
                <span className="muted" style={{ fontSize: 13, fontWeight: 600, marginLeft: 6 }}>
                  {round.progress.members} of {round.minMembers} shops in
                </span>
              </div>
            </div>
          )}

        </section>

        <aside className="pledge-panel" aria-label="Pledge">
          {phase.kind === "done" ? (
            <div className="card success rise" role="status">
              <div className="tick">
                <Icon name="check" size={34} />
              </div>
              <h2>You're in.</h2>
              <p className="muted" style={{ margin: 0 }}>
                PayPal is holding your share. You'll pay the final group price, and only if the round settles.
              </p>
              <dl>
                <dt>Your ceiling</dt>
                <dd className="num">
                  {usd(phase.maxCents)} / {unit}
                </dd>
                <dt>Up to</dt>
                <dd className="num">
                  {phase.qtyMax} {unit}
                </dd>
                <dt>Held now</dt>
                <dd className="num">{usd(phase.holdCents)}</dd>
                <dt>Authorization</dt>
                <dd className="num" style={{ fontSize: 13 }}>
                  {phase.authorizationId}
                </dd>
              </dl>
              <a className="btn btn-ghost" href="/" style={{ marginTop: 20, width: "100%" }}>
                Back to Quorum
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
              <div className="stack" style={{ gap: 14 }}>
                <div className="two">
                  <Field id="displayName" label="Your name" value={form.displayName} onChange={set("displayName")} problem={problems.displayName} show={showProblems} placeholder="Maya" autoComplete="name" />
                  <Field id="businessName" label="Shop" value={form.businessName} onChange={set("businessName")} problem={problems.businessName} show={showProblems} placeholder="Maya's Café" autoComplete="organization" />
                </div>
                <Field
                  id="maxDollars"
                  label={`Most you'll pay per ${unit}`}
                  value={form.maxDollars}
                  onChange={set("maxDollars")}
                  problem={problems.maxDollars}
                  show={showProblems}
                  prefix="$"
                  suffix={`/ ${unit}`}
                  inputMode="decimal"
                />
                <div className="two">
                  <Field id="qtyMin" label="At least" value={form.qtyMin} onChange={set("qtyMin")} problem={problems.qtyMin} show={showProblems} suffix={unit} inputMode="numeric" />
                  <Field id="qtyMax" label="At most" value={form.qtyMax} onChange={set("qtyMax")} problem={problems.qtyMax} show={showProblems} suffix={unit} inputMode="numeric" />
                </div>
              </div>

              <div className="summary" aria-live="polite">
                <div className="hold">
                  <span style={{ fontWeight: 700 }}>PayPal will hold</span>
                  <b className="num">{hold !== undefined ? usd(hold) : "—"}</b>
                </div>
                <p>Your maximum, reserved and not charged. If the round settles, you pay the final group price for your share; if not, it's all released.</p>
              </div>

              <div ref={buttonHost} className={`paypal-slot ${buttonReady ? "" : "loading"}`} aria-busy={!buttonReady} />

              {phase.kind === "approving" && (
                <div className="status" role="status">
                  <span className="spinner" /> Finish in the PayPal window…
                  <button type="button" onClick={() => setPhase({ kind: "form" })} style={{ marginLeft: "auto", background: "none", border: 0, color: "inherit", font: "inherit", textDecoration: "underline", cursor: "pointer" }}>
                    Start over
                  </button>
                </div>
              )}
              {phase.kind === "authorizing" && (
                <div className="status" role="status">
                  <span className="spinner" /> Securing your hold…
                </div>
              )}
              {phase.kind === "error" && (
                <div className="status error" role="alert">
                  {phase.message}
                </div>
              )}
              {loadError && (
                <div className="status error" role="alert">
                  {loadError}
                </div>
              )}

              <div className="fineprint">
                <Icon name="shield" size={16} />
                <span>Your limit is signed on this device and checked by Quorum before PayPal is asked for anything. Sandbox: no real money moves.</span>
              </div>
            </div>
          )}
        </aside>

        <section className="card pledge-how" style={{ padding: 24 }} aria-label="What happens to your money">
          <h3 style={{ fontSize: 18, marginBottom: 18 }}>What happens to your money</h3>
          <ol className="timeline">
            <li>
              <span className="dot">
                <Icon name="lock" size={18} />
              </span>
              <div>
                <h4>A hold, not a charge</h4>
                <p>PayPal reserves your maximum. Nothing leaves your account yet.</p>
              </div>
            </li>
            <li>
              <span className="dot">
                <Icon name="scale" size={18} />
              </span>
              <div>
                <h4>Agents negotiate for the group</h4>
                <p>The price can only land at or below the ceiling you signed.</p>
              </div>
            </li>
            <li>
              <span className="dot" style={{ background: "var(--ok-soft)", color: "var(--ok)" }}>
                <Icon name="check" size={18} />
              </span>
              <div>
                <h4>Settle or release</h4>
                <p>Target hit: you pay the final group price for your share. Target missed: the hold is released in full.</p>
              </div>
            </li>
          </ol>
        </section>
      </main>
    </Shell>
  );
}
