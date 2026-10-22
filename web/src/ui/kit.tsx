import type { ReactNode } from "react";

// Shared pieces: logo, icons, page shell. Icons are inline SVG (no icon font, nothing to load).

export function Logo({ size = 28 }: { size?: number }) {
  // Three overlapping circles: independent shops forming one buyer.
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="11" cy="13" r="8" fill="var(--brand)" opacity="0.9" />
      <circle cx="21" cy="13" r="8" fill="var(--crema)" opacity="0.85" />
      <circle cx="16" cy="21" r="8" fill="var(--ok)" opacity="0.75" />
      <circle cx="16" cy="16" r="3.2" fill="var(--surface)" />
    </svg>
  );
}

const paths: Record<string, ReactNode> = {
  lock: <path d="M7 10V7a5 5 0 0 1 10 0v3M6 10h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z" />,
  users: <path d="M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM22 19v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8" />,
  scale: <path d="M12 4v16M5 8h14M5 8l-3 7a4 4 0 0 0 6 0L5 8Zm14 0-3 7a4 4 0 0 0 6 0l-3-7ZM8 20h8" />,
  check: <path d="m5 12 4.5 4.5L19 7" />,
  clock: <path d="M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z" />,
  shield: <path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6L12 3Zm-3 9 2.2 2.2L15.5 10" />,
  bolt: <path d="M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z" />,
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  bean: <path d="M15.5 4.5c3 3 2.6 8.6-.9 12.1s-9.1 3.9-12.1.9M15.5 4.5C12.4 1.4 6.9 1.8 3.4 5.3s-3.9 9.1-.9 12.1M15.5 4.5c-2 3.3-1.5 6.2-3.9 8.6S5.8 15 2.5 17.4" />,
  sparkle: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />,
};

export function Icon({ name, size = 20, stroke = "currentColor" }: { name: keyof typeof paths; size?: number; stroke?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="topbar">
        <div className="container">
          <a className="brand" href="/" aria-label="Quorum home">
            <Logo /> Quorum
          </a>
          <span className="badge" title="Payments run in PayPal's sandbox: no real money moves">
            <Icon name="shield" size={14} /> Sandbox demo
          </span>
        </div>
      </header>
      {children}
      <footer className="footer">
        <div className="container row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
          <span>Quorum: collective buying for independent shops.</span>
          <span>Payments by PayPal (sandbox). Holds are released if a round doesn't settle.</span>
        </div>
      </footer>
    </>
  );
}
