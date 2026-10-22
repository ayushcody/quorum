import { createHash, randomUUID } from "node:crypto";
import type { PaypalClient } from "paypal";
import { createAuthorizeOrder, firstAuthorization } from "../r1/lifecycle.ts";
import type { SandboxCard } from "./card.ts";

// R2: demo-mode bot members. One createOrder with payment_source.card and intent AUTHORIZE returns
// the authorization directly, with no buyer approval. No payee: the co-op is merchant (DECISIONS D1).

export type BotRow = {
  label: string;
  ok: boolean;
  orderId?: string | undefined;
  orderStatus?: string | undefined;
  authorizationId?: string | undefined;
  authorizationStatus?: string | undefined;
  expiresAt?: string | undefined;
  mandateHash?: string;
  customId?: string | undefined;
  captureId?: string | undefined;
  captureStatus?: string | undefined;
  failure?: string;
};

export async function authorizeBots(
  client: PaypalClient,
  args: { card: SandboxCard; count: number; amountCents: number },
): Promise<BotRow[]> {
  const rows: BotRow[] = [];
  for (let i = 1; i <= args.count; i++) {
    const label = `bot-${i}`;
    // Stand-in for the signed mandate's hash until S2.3; binds the authorization to a mandate.
    const mandateHash = createHash("sha256").update(`r2-${label}-${randomUUID()}`).digest("hex");
    const created = await createAuthorizeOrder(client, {
      amountCents: args.amountCents,
      customId: mandateHash,
      invoiceId: `r2-${label}-${Date.now()}`,
      funding: { kind: "card", card: args.card },
    });
    if (!created.ok) {
      rows.push({ label, ok: false, mandateHash, failure: JSON.stringify(created) });
      continue;
    }
    const auth = firstAuthorization(created.value) as
      | { id?: string; status?: string; expirationTime?: string; customId?: string }
      | undefined;
    rows.push({
      label,
      ok: Boolean(auth?.id),
      orderId: created.value.id,
      orderStatus: created.value.status,
      authorizationId: auth?.id,
      authorizationStatus: auth?.status,
      expiresAt: auth?.expirationTime,
      mandateHash,
      customId: auth?.customId ?? created.value.purchaseUnits?.[0]?.customId,
    });
  }
  return rows;
}

export function printTable(rows: BotRow[]): void {
  console.table(
    rows.map((r) => ({
      step: r.label,
      order: r.orderId && `${r.orderId} ${r.orderStatus}`,
      authorization: r.authorizationId && `${r.authorizationId} ${r.authorizationStatus}`,
      capture: r.captureId && `${r.captureId} ${r.captureStatus}`,
      expires: r.expiresAt,
      failure: r.failure,
    })),
  );
}
