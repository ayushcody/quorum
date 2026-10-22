import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./api/app.ts";
import { loadWebEnv } from "./config/env.ts";
import { createDb } from "./db/client.ts";
import { makePingDb } from "./db/ping.ts";
import { makeLog } from "./log.ts";
import { loadSandboxCard } from "./pledge/card.ts";
import { createPayPalClient } from "./paypal/client.ts";
import { ordersHandlers } from "./paypal/orders.ts";
import { composePort } from "./paypal/port.ts";
import { payPalCertFetcher } from "./webhooks/verify.ts";

// quorum-web entry: API routes, plus the built frontend (dist/web) for every other path.
const env = loadWebEnv();
const log = makeLog("quorum-web");

// The web process only ever creates and authorizes orders; capture/void/reauth are the worker's (rule 3).
const paypal = createPayPalClient({ clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET });
const port = composePort(ordersHandlers(paypal, { cardSource: () => loadSandboxCard(process.env) }));
const database = env.DATABASE_URL ? createDb(env.DATABASE_URL) : undefined;

const app = createApp({
  webhookId: env.PAYPAL_WEBHOOK_ID,
  ...(database ? { pledges: { db: database.db, port, now: () => new Date(), paypalClientId: env.PAYPAL_CLIENT_ID } } : {}),
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
