import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SpikePage } from "./spike/SpikePage.tsx";

// No router dependency yet: one path switch until the real routes land (S2.5).
function App() {
  if (window.location.pathname === "/spike") return <SpikePage />;
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
