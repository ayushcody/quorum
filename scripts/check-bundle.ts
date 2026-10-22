import { readFileSync } from "node:fs";

// S2.5 acceptance: the pledge page (what a judge opens on a phone) must not download AG Studio or
// Bryntum. Walks the /round chunk and its static imports in Vite's manifest and searches their code.
type Chunk = { file: string; src?: string; isEntry?: boolean; imports?: string[] };
const manifest = JSON.parse(readFileSync("dist/web/.vite/manifest.json", "utf8")) as Record<string, Chunk>;
// Markers only the libraries' own code contains (URLs, AG Studio's licence banner), not words a
// page might say. The /spike chunk is the positive control that the markers still work.
const FORBIDDEN = /bryntum\.com|ag-grid\.com|License Key Not Found/;

function reachable(key: string, seen = new Set<string>()): Set<string> {
  if (seen.has(key) || !manifest[key]) return seen;
  seen.add(key);
  for (const next of manifest[key]!.imports ?? []) reachable(next, seen);
  return seen;
}

const entry = Object.keys(manifest).find((k) => manifest[k]!.isEntry);
const round = Object.keys(manifest).find((k) => k.endsWith("src/routes/Round.tsx"));
if (!entry || !round) throw new Error("manifest has no entry or no src/routes/Round.tsx chunk; run `pnpm build` first");

const spike = Object.keys(manifest).find((k) => k.endsWith("src/spike/SpikePage.tsx"));
if (spike && !FORBIDDEN.test(readFileSync(`dist/web/${manifest[spike]!.file}`, "utf8"))) {
  throw new Error("markers no longer found in the /spike chunk, which does load both libraries: update FORBIDDEN");
}

const keys = new Set([...reachable(entry), ...reachable(round)]);
const offenders = [...keys].filter((k) => FORBIDDEN.test(readFileSync(`dist/web/${manifest[k]!.file}`, "utf8")));
const kb = [...keys].reduce((sum, k) => sum + readFileSync(`dist/web/${manifest[k]!.file}`).length, 0) / 1024;
if (offenders.length > 0) {
  console.error(`pledge page pulls in AG Studio / Bryntum via: ${offenders.map((k) => manifest[k]!.file).join(", ")}`);
  process.exit(1);
}
console.log(`ok: /round loads ${keys.size} chunks, ${kb.toFixed(0)} kB, no AG Studio or Bryntum`);
