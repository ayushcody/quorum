import { Hono } from "hono";
import { authorizePledge, registerMember, registerSchema, roundSummary, submitPledge, type PledgeDeps, type PledgeError } from "./service.ts";

export const SANDBOX_SDK_URL = "https://www.sandbox.paypal.com/web-sdk/v6/core";

const STATUS: Record<PledgeError, 400 | 401 | 404 | 409 | 502 | 503> = {
  round_not_found: 404,
  member_not_found: 404,
  pledge_not_found: 404,
  not_bot: 404,
  round_closed: 409,
  already_pledged: 409,
  no_order: 409,
  not_demo_round: 409,
  malformed_payload: 400,
  invalid_mandate: 400,
  payload_mismatch: 400,
  bad_key: 401,
  bad_signature: 401,
  paypal_failed: 502,
  paypal_pending: 503,
};

// Member-facing API for /round/:id. The PayPal client id is public (v6 createInstance({ clientId })
// is PayPal's recommended setup for one-time payments); secrets never leave the server.
export function pledgeRoutes(deps: PledgeDeps & { paypalClientId: string }): Hono {
  const app = new Hono();

  app.get("/api/config", (c) => c.json({ paypalClientId: deps.paypalClientId, paypalSdkUrl: SANDBOX_SDK_URL }));

  app.get("/api/rounds/:roundId", async (c) => {
    const round = await roundSummary(deps.db, c.req.param("roundId"));
    return round ? c.json(round) : c.json({ error: "round_not_found" }, 404);
  });

  app.post("/api/members", async (c) => {
    const parsed = registerSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_member" }, 400);
    return c.json(await registerMember(deps.db, parsed.data), 201);
  });

  app.post("/api/rounds/:roundId/pledges", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { memberId?: unknown; payload?: unknown; signature?: unknown } | null;
    if (!body || typeof body.memberId !== "string" || typeof body.signature !== "string") return c.json({ error: "malformed_payload" }, 400);
    const result = await submitPledge(deps, { roundId: c.req.param("roundId"), memberId: body.memberId, payload: body.payload, signature: body.signature });
    if (!result.ok) return c.json({ error: result.error }, STATUS[result.error]);
    const { created, ...out } = result;
    return c.json(out, created ? 201 : 200);
  });

  app.post("/api/pledges/:pledgeId/authorize", async (c) => {
    const result = await authorizePledge(deps, c.req.param("pledgeId"));
    if (!result.ok) return c.json({ error: result.error }, STATUS[result.error]);
    return c.json({ pledgeId: result.pledgeId, authorizationId: result.authorizationId });
  });

  return app;
}
