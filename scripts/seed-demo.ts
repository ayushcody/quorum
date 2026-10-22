import { generateKeyPairSync } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createDb } from "../src/db/client.ts";
import { demoSigningKeys, members, rounds } from "../src/db/schema.ts";

// `pnpm seed:demo`: one open demo round plus bot members for judge mode (DECISIONS D4).
// Fixed ids make it idempotent: re-running inserts nothing and keeps each bot's first key pair.

export const DEMO_ROUND_ID = "00000000-0000-4000-8000-00000000d001";

const BOTS = [
  { id: "00000000-0000-4000-8000-0000000b0001", displayName: "Maya", businessName: "Maya's Café" },
  { id: "00000000-0000-4000-8000-0000000b0002", displayName: "Theo", businessName: "Bean There" },
  { id: "00000000-0000-4000-8000-0000000b0003", displayName: "Priya", businessName: "Corner Roast" },
  { id: "00000000-0000-4000-8000-0000000b0004", displayName: "Sam", businessName: "Daily Grind" },
] as const;

const HOUR = 3_600_000;

export async function seedDemo(databaseUrl: string, now: Date = new Date()): Promise<void> {
  const { db, close } = createDb(databaseUrl, { max: 1 });
  try {
    await db.transaction(async (tx) => {
      for (const bot of BOTS) {
        const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
        await tx
          .insert(members)
          .values({ ...bot, kind: "bot", publicKeyJwk: publicKey.export({ format: "jwk" }) })
          .onConflictDoNothing({ target: members.id });
        // Only the first run's key is kept: a conflicting insert leaves the stored pair untouched,
        // and members.public_key_jwk above was also only written on the first run.
        await tx
          .insert(demoSigningKeys)
          .values({ memberId: bot.id, privateKeyJwk: privateKey.export({ format: "jwk" }) })
          .onConflictDoNothing({ target: demoSigningKeys.memberId });
      }
      await tx
        .insert(rounds)
        .values({
          id: DEMO_ROUND_ID,
          title: "200 kg Ethiopian single-origin, deliver in 10 days",
          sku: "coffee-ethiopia-yirgacheffe-kg",
          unit: "kg",
          targetQty: 200,
          minMembers: 3,
          pledgeDeadlineAt: new Date(now.getTime() + 48 * HOUR),
          deliveryBy: new Date(now.getTime() + 240 * HOUR).toISOString().slice(0, 10),
          supplierRef: "demo-supplier",
          status: "open",
          isDemo: true,
        })
        .onConflictDoNothing({ target: rounds.id });
    });
  } finally {
    await close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required (local: `pnpm db:up`, then postgres://postgres:dev@localhost:5432/postgres)");
  await seedDemo(url);
  console.log(`seeded demo round ${DEMO_ROUND_ID} and ${BOTS.length} bot members`);
}
