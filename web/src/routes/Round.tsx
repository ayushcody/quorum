import { useEffect, useRef, useState } from "react";
import { signMandate, toMandatePayload, type SigningKey } from "../../../src/pledge/mandate-sign.ts";
import { createPayPalSession } from "../paypal/v6.ts";

// /round/:id: the page a member (or a judge, on a phone) opens to pledge. It signs the mandate in
// the browser (WebCrypto P-256), the server creates the AUTHORIZE order, and the buyer approves in
// PayPal's v6 popup. No money moves here: it's a hold, captured only if the round settles.

type Config = { paypalClientId: string; paypalSdkUrl: string };
type RoundInfo = { id: string; title: string; unit: string; targetQty: number; minMembers: number; status: string; pledgeDeadlineAt: string; isDemo: boolean };
type Phase = { kind: "form" } | { kind: "approving" } | { kind: "authorizing" } | { kind: "done"; authorizationId: string } | { kind: "error"; message: string };

const HONOR_MS = 72 * 3_600_000;

type FormState = { displayName: string; businessName: string; maxDollars: string; qtyMin: string; qtyMax: string };

function formProblem(f: FormState): string | undefined {
  if (!f.displayName.trim() || !f.businessName.trim()) return "Enter your name and business first.";
  if (!/^\d+(\.\d{1,2})?$/.test(f.maxDollars.trim()) || Number(f.maxDollars) <= 0) return "Enter the most you'll pay as dollars, e.g. 14.00.";
  const min = Number(f.qtyMin);
  const max = Number(f.qtyMax);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min) return "Quantities must be whole numbers, with max ≥ min ≥ 1.";
  return undefined;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export function RoundPage({ roundId }: { roundId: string }) {
  const [config, setConfig] = useState<Config>();
  const [round, setRound] = useState<RoundInfo>();
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [form, setForm] = useState({ displayName: "", businessName: "", maxDollars: "14.00", qtyMin: "10", qtyMax: "30" });
  const formRef = useRef(form);
  formRef.current = form;
  const buttonHost = useRef<HTMLDivElement>(null);
  // This browser's signing key for the session; the private key never leaves it.
  const identity = useRef<{ memberId: string; privateKey: SigningKey }>(undefined);
  const pledgeId = useRef<string>(undefined);

  useEffect(() => {
    Promise.all([api<Config>("/api/config"), api<RoundInfo>(`/api/rounds/${roundId}`)])
      .then(([c, r]) => {
        setConfig(c);
        setRound(r);
      })
      .catch((e: Error) => setPhase({ kind: "error", message: e.message }));
  }, [roundId]);

  useEffect(() => {
    if (!config || !round || !buttonHost.current) return;
    let cancelled = false;
    const host = buttonHost.current;

    // Sign the mandate and create the order. Called inside the click so the popup keeps the user gesture.
    const createOrder = async (): Promise<{ orderId: string }> => {
      const f = formRef.current;
      if (!identity.current) {
        const pair = await globalThis.crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
        const publicKeyJwk = await globalThis.crypto.subtle.exportKey("jwk", pair.publicKey);
        const { memberId } = await api<{ memberId: string }>("/api/members", {
          method: "POST",
          body: JSON.stringify({ displayName: f.displayName, businessName: f.businessName, publicKeyJwk }),
        });
        identity.current = { memberId, privateKey: pair.privateKey };
      }
      const [dollars = "0", fraction = ""] = f.maxDollars.trim().split(".");
      const payload = toMandatePayload({
        roundId: round.id,
        memberId: identity.current.memberId,
        maxUnitPriceCents: BigInt(dollars) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2) || "0"),
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
          setPhase({ kind: "done", authorizationId });
        } catch (e) {
          setPhase({ kind: "error", message: (e as Error).message });
        }
      },
      onCancel: () => setPhase({ kind: "form" }),
      onError: (e) => setPhase({ kind: "error", message: e instanceof Error ? e.message : "PayPal error" }),
    })
      .then((session) => {
        if (cancelled) return;
        if (!session) return setPhase({ kind: "error", message: "PayPal isn't available for this browser" });
        const button = document.createElement("paypal-button");
        button.setAttribute("type", "pay");
        button.addEventListener("click", () => {
          // Check the form before PayPal opens: a popup for an order that can't be created is a dead end.
          const problem = formProblem(formRef.current);
          if (problem) return setPhase({ kind: "error", message: problem });
          setPhase({ kind: "approving" });
          const order = createOrder();
          order.catch((e: Error) => setPhase({ kind: "error", message: e.message }));
          void session.start({ presentationMode: "auto" }, order);
        });
        host.replaceChildren(button);
      })
      .catch((e: Error) => setPhase({ kind: "error", message: e.message }));
    return () => {
      cancelled = true;
      host.replaceChildren();
    };
  }, [config, round]);

  const field = (key: keyof typeof form, label: string, inputMode: "text" | "decimal" | "numeric" = "text") => (
    <label style={{ display: "grid", gap: 4 }}>
      <span style={{ fontSize: 14, color: "#444" }}>{label}</span>
      <input value={form[key]} inputMode={inputMode} onChange={(e) => setForm({ ...form, [key]: e.target.value })} style={{ fontSize: 16, padding: 10, borderRadius: 8, border: "1px solid #ccc" }} />
    </label>
  );

  return (
    <main style={{ fontFamily: "system-ui", maxWidth: 480, margin: "0 auto", padding: 16, display: "grid", gap: 16 }}>
      {round ? (
        <header>
          <h1 style={{ fontSize: 22, margin: 0 }}>{round.title}</h1>
          <p style={{ margin: "4px 0 0", color: "#555" }}>
            Target {round.targetQty} {round.unit} · at least {round.minMembers} members · pledges close {new Date(round.pledgeDeadlineAt).toLocaleString()}
          </p>
        </header>
      ) : (
        <p>Loading round…</p>
      )}
      {phase.kind === "done" ? (
        <section style={{ padding: 16, borderRadius: 12, background: "#eef8ee" }}>
          <strong>Pledge authorized.</strong> PayPal is holding your maximum; you're charged only the final group price, and only if the round settles.
          <div style={{ fontSize: 13, color: "#555", marginTop: 8 }}>Authorization {phase.authorizationId}</div>
        </section>
      ) : (
        <>
          {field("displayName", "Your name")}
          {field("businessName", "Business")}
          {field("maxDollars", `Most you'll pay per ${round?.unit ?? "unit"} ($)`, "decimal")}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {field("qtyMin", `Min ${round?.unit ?? ""}`, "numeric")}
            {field("qtyMax", `Max ${round?.unit ?? ""}`, "numeric")}
          </div>
          <div ref={buttonHost} style={{ minHeight: 48 }} />
          {phase.kind === "approving" && <p>Waiting for PayPal approval…</p>}
          {phase.kind === "authorizing" && <p>Authorizing your hold…</p>}
          {phase.kind === "error" && <p style={{ color: "#a00" }}>Something went wrong: {phase.message}</p>}
        </>
      )}
    </main>
  );
}
