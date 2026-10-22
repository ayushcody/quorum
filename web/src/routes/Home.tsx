import { useEffect, useState } from "react";
import { countdown, progress } from "../ui/format.ts";
import { Icon, Shell } from "../ui/kit.tsx";

export type RoundSummary = {
  id: string;
  title: string;
  unit: string;
  targetQty: number;
  minMembers: number;
  status: string;
  pledgeDeadlineAt: string;
  deliveryBy: string;
  isDemo: boolean;
  progress: { pledgedQty: number; members: number };
};

export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function RoundCard({ round, now }: { round: RoundSummary; now: Date }) {
  const p = progress(round.progress.pledgedQty, round.targetQty);
  const left = countdown(new Date(round.pledgeDeadlineAt), now);
  return (
    <div className="card round-card stack rise">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="badge ok">
          <span style={{ width: 7, height: 7, borderRadius: 9, background: "currentColor" }} /> Live round
        </span>
        <span className="muted num" style={{ fontSize: 14, fontWeight: 600 }}>
          <Icon name="clock" size={14} /> {left.label}
        </span>
      </div>
      <div className="product">
        <div className="product-icon">
          <Icon name="bean" size={26} />
        </div>
        <div>
          <h3 style={{ fontSize: 18 }}>{round.title}</h3>
          <div className="muted" style={{ fontSize: 14 }}>Delivered by {new Date(round.deliveryBy).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</div>
        </div>
      </div>
      <div>
        <div className={`meter ${p.reached ? "reached" : ""}`} role="progressbar" aria-valuenow={p.percent} aria-valuemin={0} aria-valuemax={100} aria-label="Quantity pledged toward the target">
          <span style={{ width: `${Math.max(p.barPercent, 3)}%` }} />
        </div>
      </div>
      <div className="stat-row">
        <div className="stat">
          <b className="num">{round.progress.pledgedQty}</b>
          <small>
            of {round.targetQty} {round.unit}
          </small>
        </div>
        <div className="stat">
          <b className="num">{round.progress.members}</b>
          <small>of {round.minMembers} shops</small>
        </div>
        <div className="stat">
          <b className="num">{p.percent}%</b>
          <small>to quorum</small>
        </div>
      </div>
      <a className="btn btn-primary" href={`/round/${round.id}`}>
        Join this round <Icon name="arrow" size={18} />
      </a>
    </div>
  );
}

export function HomePage() {
  const [round, setRound] = useState<RoundSummary | null>();
  const now = useNow();

  useEffect(() => {
    fetch("/api/rounds")
      .then((r) => r.json() as Promise<{ rounds: RoundSummary[] }>)
      .then((body) => setRound(body.rounds[0] ?? null))
      .catch(() => setRound(null));
  }, []);

  return (
    <Shell>
      <main>
        <section className="hero">
          <div className="container hero-grid">
            <div>
              <div className="eyebrow">Collective buying, settled on PayPal</div>
              <h1 style={{ marginTop: 14 }}>
                Buy like a chain.
                <br />
                <em>Pay like a neighbor.</em>
              </h1>
              <p className="lede">
                Independent cafés pool one wholesale order. AI agents negotiate the volume price. PayPal holds each share, and charges it only if the group hits its target.
              </p>
              <div className="cta-row">
                {round ? (
                  <a className="btn btn-primary" href={`/round/${round.id}`}>
                    Join the open round <Icon name="arrow" size={18} />
                  </a>
                ) : null}
                <a className="btn btn-ghost" href="#how">
                  How it works
                </a>
              </div>
              <div className="trust">
                <span>
                  <Icon name="lock" size={16} /> Held, not charged
                </span>
                <span>
                  <Icon name="shield" size={16} /> Your limit, signed by you
                </span>
                <span>
                  <Icon name="users" size={16} /> All or nothing
                </span>
              </div>
            </div>
            <div>
              {round === undefined ? (
                <div className="card round-card" style={{ minHeight: 360 }} aria-busy="true" />
              ) : round ? (
                <RoundCard round={round} now={now} />
              ) : (
                <div className="card round-card stack">
                  <h3>No round is open right now</h3>
                  <p className="muted">The next buying round opens soon. Check back shortly.</p>
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="section" id="how">
          <div className="container">
            <div className="eyebrow">How it works</div>
            <h2 style={{ marginTop: 10 }}>The buying power of a chain, without anyone fronting the cash.</h2>
            <div className="steps">
              <article className="card step">
                <div className="n">1</div>
                <h3>Set your ceiling</h3>
                <p>Say the most you'll pay per kilo and how much you want. You sign that promise, and PayPal places a hold, not a charge.</p>
              </article>
              <article className="card step">
                <div className="n">2</div>
                <h3>Agents negotiate</h3>
                <p>Our buyer agent bargains with the supplier's agent for the whole group. The price can only come in at or under your ceiling.</p>
              </article>
              <article className="card step">
                <div className="n">3</div>
                <h3>Settle or release</h3>
                <p>Hit the target, and everyone pays the lower group price. Miss it, and every hold is released. Nobody pays for a deal that didn't happen.</p>
              </article>
            </div>
          </div>
        </section>
      </main>
    </Shell>
  );
}
