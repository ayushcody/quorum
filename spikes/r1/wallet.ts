import { createInterface } from "node:readline/promises";
import { buildClients, loadR1Env } from "./clients.ts";
import { approveLink, authorizeOrder, capturePartial, createAuthorizeOrder, firstAuthorization, reauthorize } from "./lifecycle.ts";

// R1, wallet funding (manual). Card funding is covered by test/sandbox/auth-lifecycle.sandbox.test.ts;
// this checks the same lifecycle when a sandbox personal account approves in the PayPal popup.
// Run: node --env-file=.env --import tsx spikes/r1/wallet.ts

const env = loadR1Env();
const { coop } = buildClients(env);

const created = await createAuthorizeOrder(coop, {
  amountCents: 1000,
  payeeMerchantId: env.SUPPLIER_MERCHANT_ID,
  customId: "r1-wallet",
  invoiceId: `r1-wallet-${Date.now()}`,
  funding: { kind: "wallet" },
});
if (!created.ok) throw new Error(`createOrder failed: ${JSON.stringify(created)}`);

console.log(`\nApprove as a sandbox PERSONAL account:\n  ${approveLink(created.value)}\n`);
const rl = createInterface({ input: process.stdin, output: process.stdout });
await rl.question("Press Enter once approved (the return page may 404; that is fine)… ");
rl.close();

const authorized = await authorizeOrder(coop, created.value.id!);
console.log("authorize:", JSON.stringify(authorized, null, 2));
if (!authorized.ok) process.exit(1);
const authorizationId = firstAuthorization(authorized.value)!.id!;

console.log("reauthorize (inside honor period):", JSON.stringify(await reauthorize(coop, authorizationId, 1000), null, 2));
console.log("capture 6.00 final:", JSON.stringify(await capturePartial(coop, authorizationId, 600), null, 2));
