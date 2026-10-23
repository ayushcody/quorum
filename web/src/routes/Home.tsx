import { countdown, progress } from "../ui/format.ts";
import { Icon, Shell } from "../ui/kit.tsx";
import { useNow, usePolling, type RoundSummary } from "../ui/live.ts";
import { describeFailure } from "../ui/pledge.ts";

export function RoundCard({ round, now }: { round: RoundSummary; now: Date }) {
  const p = progress(round.progress.pledgedQty, round.targetQty);
  const left = countdown(new Date(round.pledgeDeadlineAt), now);
  return (
    <div className="card round-card stack rise">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="badge ok">
          <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: 9, background: "currentColor" }} /> Live round
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
          <h2 style={{ fontSize: 18 }}>{round.title}</h2>
          <div className="muted" style={{ fontSize: 14 }}>Delivered by {new Date(round.deliveryBy).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</div>
        </div>
      </div>
      <div>
        <div className={`meter ${p.reached ? "reached" : ""}`} role="progressbar" aria-valuenow={p.barPercent} aria-valuemin={0} aria-valuemax={100} aria-valuetext={`${round.progress.pledgedQty} of ${round.targetQty} ${round.unit} pledged`} aria-label="Pledged toward the target">
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
      <a className="btn btn-primary" href={`/round/${round.id}`} aria-label={`Join this round: ${round.title}`}>
        Join this round <Icon name="arrow" size={18} />
      </a>
    </div>
  );
}

export function HomePage() {
  // Refreshes so the card's meter moves as shops pledge; a failed poll keeps the last good card.
  const live = usePolling<{ rounds: RoundSummary[] }>("/api/rounds", 10_000);
  const round = live.data ? (live.data.rounds[0] ?? null) : undefined;
  const now = useNow();

  return (
    <Shell>
      <main id="main">
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
              {round === undefined && live.failure ? (
                <div className="card round-card stack" role="status">
                  <h2 style={{ fontSize: 20 }}>{describeFailure(live.failure).title}</h2>
                  <p className="muted" style={{ margin: 0 }}>
                    We'll keep trying. The open round appears here as soon as Quorum answers.
                  </p>
                </div>
              ) : round === undefined ? (
                <div className="card round-card skeleton" style={{ minHeight: 360 }} aria-busy="true" aria-label="Loading the open round" />
              ) : round ? (
                <RoundCard round={round} now={now} />
              ) : (
                <div className="card round-card stack">
                  <h2 style={{ fontSize: 20 }}>No round is open right now</h2>
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
