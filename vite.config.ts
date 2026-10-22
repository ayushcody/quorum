import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Frontend lives in web/; env (VITE_* only) is read from the project-root .env.
export default defineConfig({
  root: "web",
  envDir: "..",
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: { outDir: "../dist/web", emptyOutDir: true },
});
