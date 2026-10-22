import { z } from "zod";
import { parseEnv } from "../config/env.ts";

// PayPal sandbox test card for demo-mode bot members (DECISIONS D4). Test values only, from .env.

export type SandboxCard = { number: string; expiry: string; securityCode: string };

// PayPal wants YYYY-MM; the developer dashboard's card generator shows MM/YYYY. Accept both.
export function normalizeExpiry(raw: string): string | undefined {
  const iso = /^(\d{4})-(\d{2})$/.exec(raw);
  const slash = /^(\d{2})\/(\d{4})$/.exec(raw);
  const [year, month] = iso ? [iso[1], iso[2]] : slash ? [slash[2], slash[1]] : [];
  if (!year || !month || Number(month) < 1 || Number(month) > 12) return undefined;
  return `${year}-${month}`;
}

const cardSchema = z.object({
  SANDBOX_CARD_NUMBER: z.string().regex(/^\d{13,19}$/),
  SANDBOX_CARD_EXPIRY: z.string().refine((v) => normalizeExpiry(v) !== undefined),
  SANDBOX_CARD_CVV: z.string().regex(/^\d{3,4}$/),
});

export function loadSandboxCard(source: Record<string, string | undefined>): SandboxCard {
  const env = parseEnv(cardSchema, source);
  return { number: env.SANDBOX_CARD_NUMBER, expiry: normalizeExpiry(env.SANDBOX_CARD_EXPIRY)!, securityCode: env.SANDBOX_CARD_CVV };
}
