import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Frontend lives in web/; env (VITE_* only) is read from the project-root .env.
export default defineConfig({
  root: "web",
  envDir: "..",
  plugins: [react()],
  // In dev the API runs separately (`pnpm dev:api`, port 3000); the browser stays same-origin via the proxy.
  server: { port: 5173, strictPort: true, proxy: { "/api": "http://localhost:3000", "/health": "http://localhost:3000" } },
  // The manifest lets scripts/check-bundle.ts prove the pledge page ships without AG Studio or Bryntum.
  build: { outDir: "../dist/web", emptyOutDir: true, manifest: true },
});
