import { z } from "zod";

// Sandbox only (CLAUDE.md). Any other base URL is a boot failure, not a warning.
export const SANDBOX_BASE_URL = "https://api-m.sandbox.paypal.com";

export class EnvError extends Error {
  override name = "EnvError";
}

const nonEmpty = z.string().trim().min(1);

const coordinatorSchema = z.object({
  PAYPAL_ENV: z.literal("sandbox"),
  PAYPAL_BASE_URL: z.literal(SANDBOX_BASE_URL).default(SANDBOX_BASE_URL),
  PAYPAL_CLIENT_ID: nonEmpty,
  PAYPAL_CLIENT_SECRET: nonEmpty,
});

export type CoordinatorEnv = z.infer<typeof coordinatorSchema>;

type EnvSource = Record<string, string | undefined>;

export function parseEnv<S extends z.ZodType>(schema: S, source: EnvSource): z.infer<S> {
  const result = schema.safeParse(source);
  if (result.success) return result.data;
  // Report key names only: values may be secrets.
  const keys = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
  throw new EnvError(`Invalid or missing env: ${keys.join(", ")}`);
}

export function loadCoordinatorEnv(source: EnvSource = process.env): CoordinatorEnv {
  return parseEnv(coordinatorSchema, source);
}
