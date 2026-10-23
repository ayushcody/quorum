import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// WCAG 2.2 AA on the real tokens: body text 4.5:1, large text and UI parts 3:1. Reads styles.css so a
// token tweak that breaks contrast fails here, in both themes.

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

function tokens(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

const light = tokens(/:root\s*{([\s\S]*?)\n}/.exec(css)![1]!);
const dark = { ...light, ...tokens(/@media \(prefers-color-scheme: dark\)\s*{\s*:root[^{]*{([\s\S]*?)\n  }/.exec(css)![1]!) };

type Rgba = [number, number, number, number];
function parse(color: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)).concat(1) as Rgba;
  const rgba = /^rgba?\(([^)]+)\)$/.exec(color);
  if (rgba) {
    const [r, g, b, a = "1"] = rgba[1]!.split(",").map((s) => s.trim());
    return [Number(r), Number(g), Number(b), Number(a)];
  }
  throw new Error(`unparsed color ${color}`);
}

// A translucent colour as it actually renders on its backdrop.
function over(top: Rgba, under: Rgba): Rgba {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i]! * a + under[i]! * (1 - a)).concat(1) as Rgba;
}

function luminance([r, g, b]: Rgba): number {
  const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function ratio(fg: string, bg: string, t: Record<string, string>, backdrop = "surface"): number {
  const base = parse(t[backdrop]!);
  const b = over(parse(t[bg]!), base);
  const f = over(parse(t[fg]!), b);
  const [hi, lo] = [luminance(f), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

// [text token, background token, minimum]
const PAIRS: [string, string, number][] = [
  ["ink", "bg", 4.5],
  ["ink-2", "surface", 4.5],
  ["muted", "surface", 4.5],
  ["muted", "bg", 4.5],
  ["muted", "surface-2", 4.5],
  ["brand", "surface", 4.5], // links and the eyebrow
  ["brand", "bg", 4.5],
  ["on-brand", "brand", 4.5], // primary button label
  ["brand-ink", "brand-soft", 4.5], // badges, status, step numbers
  ["ok", "ok-soft", 4.5],
  ["ok", "surface", 3], // icons and the "reached" meter
  ["danger", "danger-soft", 4.5],
  ["danger", "surface", 4.5], // field error text
  ["crema-ink", "crema-soft", 4.5], // "Sandbox demo" badge
  ["field-line", "surface", 3], // input borders (WCAG 1.4.11 non-text contrast)
  ["field-line", "surface-2", 3],
  ["line-strong", "surface", 1.4], // decorative borders only; inputs also carry a label
];

describe.each([
  ["light", light],
  ["dark", dark],
])("contrast, %s theme", (_name, t) => {
  it.each(PAIRS)("%s on %s ≥ %f:1", (fg, bg, min) => {
    expect(ratio(fg, bg, t)).toBeGreaterThanOrEqual(min);
  });
});
