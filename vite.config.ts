import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Quorum's dev API port. Not 3000: other local projects (e.g. Next.js apps) commonly hold it.
const api = `http://localhost:${process.env.QUORUM_API_PORT ?? "3100"}`;

// Frontend lives in web/; env (VITE_* only) is read from the project-root .env.
export default defineConfig({
  root: "web",
  envDir: "..",
  plugins: [react()],
  // In dev the API runs separately (`pnpm dev:api`, port 3100); the browser stays same-origin via the proxy.
  server: { port: 5173, strictPort: true, proxy: { "/api": api, "/health": api } },
  // The manifest lets scripts/check-bundle.ts prove the pledge page ships without AG Studio or Bryntum.
  build: { outDir: "../dist/web", emptyOutDir: true, manifest: true },
});
