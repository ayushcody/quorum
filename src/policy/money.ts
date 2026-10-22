// Money is integer cents in bigint: no floats anywhere near money (ARCHITECTURE §0).

export type Cents = bigint & { readonly __cents: unique symbol };

export function cents(value: bigint | number): Cents {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`not a non-negative integer cent amount: ${value}`);
    return BigInt(value) as Cents;
  }
  if (value < 0n) throw new RangeError(`negative cent amount: ${value}`);
  return value as Cents;
}

export function addCents(...values: Cents[]): Cents {
  return values.reduce((sum, v) => sum + v, 0n) as Cents;
}

export function mulCents(unit: Cents, qty: number): Cents {
  if (!Number.isSafeInteger(qty) || qty < 0) throw new RangeError(`qty must be a non-negative integer: ${qty}`);
  return (unit * BigInt(qty)) as Cents;
}

export function minCents(a: Cents, b: Cents): Cents {
  return a <= b ? a : b;
}

export function toDollars(value: Cents): string {
  const whole = value / 100n;
  const rest = value % 100n;
  return `${whole}.${rest.toString().padStart(2, "0")}`;
}

// "12", "12.3", "12.34" → cents. Anything else (signs, 3+ decimals, blanks, exponents) throws.
export function fromDollars(text: string): Cents {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new RangeError(`not a dollar amount: ${JSON.stringify(text)}`);
  const [, whole, fraction = ""] = match;
  return (BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"))) as Cents;
}
