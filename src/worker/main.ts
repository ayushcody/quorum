import { loadWorkerEnv } from "../config/env.ts";
import { makePingDb } from "../db/ping.ts";
import { makeLog } from "../log.ts";

// quorum-worker entry. S1.4: a heartbeat that proves the process runs and can reach Postgres on
// Render. The outbox executor, settlement and negotiation ticks join this loop in Phases 2–3.
const env = loadWorkerEnv();
const log = makeLog("quorum-worker");
const pingDb = env.DATABASE_URL ? makePingDb(env.DATABASE_URL) : undefined;
const HEARTBEAT_MS = 60_000;

async function heartbeat() {
  let db = "unconfigured";
  if (pingDb) {
    try {
      await pingDb();
      db = "ok";
    } catch (err) {
      db = `down: ${(err as Error).message}`;
    }
  }
  log("heartbeat", { db });
}

log("started", { heartbeatMs: HEARTBEAT_MS });
void heartbeat();
const timer = setInterval(() => void heartbeat(), HEARTBEAT_MS);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log("shutdown", { signal });
    clearInterval(timer);
    process.exit(0);
  });
}
