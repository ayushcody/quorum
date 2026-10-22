import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
// Heavy libraries load per route: AG Studio and Bryntum must never be in the shell a phone downloads first.
const SpikePage = lazy(() => import("./spike/SpikePage.tsx").then((m) => ({ default: m.SpikePage })));
const RoundPage = lazy(() => import("./routes/Round.tsx").then((m) => ({ default: m.RoundPage })));

// No router dependency yet: one path switch until the real routes land (S2.5).
function App() {
  const round = /^\/round\/([0-9a-f-]{36})$/i.exec(window.location.pathname);
  if (round) {
    return (
      <Suspense fallback={<p style={{ fontFamily: "system-ui", padding: 24 }}>Loading…</p>}>
        <RoundPage roundId={round[1]!} />
      </Suspense>
    );
  }
  if (window.location.pathname === "/spike") {
    return (
      <Suspense fallback={<p style={{ fontFamily: "system-ui", padding: 24 }}>Loading…</p>}>
        <SpikePage />
      </Suspense>
    );
  }
  return (
    <main style={{ fontFamily: "system-ui", padding: 24 }}>
      <h1>Quorum</h1>
      <p>
        <a href="/spike">/spike</a>: R3 spike (AG Studio + Bryntum Scheduler Pro)
      </p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
