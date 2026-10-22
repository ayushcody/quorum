import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./api/app.ts";
import { loadWebEnv } from "./config/env.ts";
import { makePingDb } from "./db/ping.ts";
import { makeLog } from "./log.ts";
import { payPalCertFetcher } from "./webhooks/verify.ts";

// quorum-web entry: API routes, plus the built frontend (dist/web) for every other path.
const env = loadWebEnv();
const log = makeLog("quorum-web");

const app = createApp({
  webhookId: env.PAYPAL_WEBHOOK_ID,
  getPublicKey: payPalCertFetcher(),
  ...(env.DATABASE_URL ? { pingDb: makePingDb(env.DATABASE_URL) } : {}),
  log,
});
app.use("/*", serveStatic({ root: "./dist/web" }));
// Client-side routes (/spike, /round/:id …) fall back to the SPA shell.
app.get("*", serveStatic({ path: "./dist/web/index.html" }));

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  log("listening", { port: info.port, db: env.DATABASE_URL ? "configured" : "unconfigured", webhook: env.PAYPAL_WEBHOOK_ID ? "configured" : "unset" });
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log("shutdown", { signal });
    server.close(() => process.exit(0));
  });
}
