// Display helpers. Money stays integer cents (bigint) until the moment it's printed.

export function usd(cents: bigint | number): string {
  const c = BigInt(cents);
  const whole = (c / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${whole}.${(c % 100n).toString().padStart(2, "0")}`;
}

// What people type ("14", "14.5", "$14.05") → cents. Zero, negatives and fractions of a cent are refused.
export function parseDollars(text: string): bigint | undefined {
  const m = /^\$?(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return undefined;
  const value = BigInt(m[1]!) * 100n + BigInt((m[2] ?? "").padEnd(2, "0"));
  return value > 0n ? value : undefined;
}

// The PayPal hold: the ceiling price for the most the member would take.
export function holdCents(maxUnitCents: bigint | undefined, qtyMax: number): bigint | undefined {
  if (maxUnitCents === undefined || !Number.isSafeInteger(qtyMax) || qtyMax <= 0) return undefined;
  return maxUnitCents * BigInt(qtyMax);
}

export function progress(pledged: number, target: number): { percent: number; barPercent: number; reached: boolean } {
  if (target <= 0) return { percent: 0, barPercent: 0, reached: false };
  const percent = Math.round((pledged / target) * 100);
  return { percent, barPercent: Math.min(100, percent), reached: pledged >= target };
}

export function countdown(deadline: Date, now: Date): { closed: boolean; label: string } {
  const ms = deadline.getTime() - now.getTime();
  if (ms <= 0) return { closed: true, label: "Pledging closed" };
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return { closed: false, label: "under a minute left" };
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const mins = minutes % 60;
  if (days > 0) return { closed: false, label: `${days}d ${hours}h left` };
  if (hours > 0) return { closed: false, label: `${hours}h ${mins}m left` };
  return { closed: false, label: `${mins}m left` };
}
