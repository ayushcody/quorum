import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./pages.css";
import { HomePage } from "./routes/Home.tsx";
// Heavy libraries load per route: AG Studio and Bryntum must never be in the shell a phone downloads first.
const SpikePage = lazy(() => import("./spike/SpikePage.tsx").then((m) => ({ default: m.SpikePage })));
const RoundPage = lazy(() => import("./routes/Round.tsx").then((m) => ({ default: m.RoundPage })));

const fallback = (
  <div style={{ display: "grid", placeItems: "center", minHeight: "60vh" }}>
    <span className="spinner" aria-label="Loading" />
  </div>
);

// No router dependency yet: one path switch until there are more routes.
function App() {
  const round = /^\/round\/([0-9a-f-]{36})$/i.exec(window.location.pathname);
  if (round) {
    return (
      <Suspense fallback={fallback}>
        <RoundPage roundId={round[1]!} />
      </Suspense>
    );
  }
  if (window.location.pathname === "/spike") {
    return (
      <Suspense fallback={fallback}>
        <SpikePage />
      </Suspense>
    );
  }
  return <HomePage />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
