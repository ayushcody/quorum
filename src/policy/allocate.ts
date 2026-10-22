export type Ask = { pledgeId: string; qtyMin: number; qtyMax: number };

// Quantities per pledge. Everyone gets qtyMax unless the supplier caps supply; then each pledge is cut
// toward its qtyMin in proportion to its flexibility (qtyMax − qtyMin), in whole units by largest
// remainder, ties broken by pledgeId. null when even everyone's qtyMin exceeds the cap.
export function allocate(asks: readonly Ask[], supplyCap?: number): Map<string, number> | null {
  const ordered = [...asks].sort((a, b) => (a.pledgeId < b.pledgeId ? -1 : a.pledgeId > b.pledgeId ? 1 : 0));
  const totalMax = ordered.reduce((s, a) => s + a.qtyMax, 0);
  const totalMin = ordered.reduce((s, a) => s + a.qtyMin, 0);
  if (supplyCap === undefined || supplyCap >= totalMax) return new Map(ordered.map((a) => [a.pledgeId, a.qtyMax]));
  if (totalMin > supplyCap) return null;

  const cut = totalMax - supplyCap; // units to remove, 0 < cut ≤ Σ flex
  const flexTotal = totalMax - totalMin;
  // Integer arithmetic: share_i = cut × flex_i / flexTotal, floor first, then hand out the remainder.
  const shares = ordered.map((a) => {
    const flex = a.qtyMax - a.qtyMin;
    const exact = BigInt(cut) * BigInt(flex);
    return { ask: a, flex, base: Number(exact / BigInt(flexTotal)), remainder: exact % BigInt(flexTotal) };
  });
  let left = cut - shares.reduce((s, x) => s + x.base, 0);
  const byRemainder = [...shares].sort((x, y) => (x.remainder > y.remainder ? -1 : x.remainder < y.remainder ? 1 : x.ask.pledgeId < y.ask.pledgeId ? -1 : 1));
  for (const share of byRemainder) {
    if (left === 0) break;
    if (share.base < share.flex) {
      share.base += 1;
      left -= 1;
    }
  }
  return new Map(shares.map((x) => [x.ask.pledgeId, x.ask.qtyMax - x.base]));
}
