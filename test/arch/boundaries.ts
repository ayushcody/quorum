import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { posix } from "node:path";
import ts from "typescript";

// Import rules from docs/ARCHITECTURE.md §2. Production code only: *.test.ts files are not scanned.

export type SourceFile = { path: string; source: string };
export type Violation = { rule: string; file: string; specifier: string };

type Target = { kind: "internal"; id: string } | { kind: "package"; name: string };

const LLM_FILES = ["src/negotiation/narrator", "src/supplier/narrator"];
const isLlmFile = (id: string) => id.startsWith("src/agents/") || LLM_FILES.includes(id);
const under = (id: string, dir: string) => id.startsWith(`${dir}/`);

type Rule = { name: string; violates: (from: string, target: Target) => boolean };

const rules: Rule[] = [
  {
    name: "policy-pure",
    violates: (from, t) => under(from, "src/policy") && !(t.kind === "internal" && under(t.id, "src/policy")),
  },
  {
    name: "sdk-only-in-client",
    violates: (from, t) => t.kind === "package" && t.name === "paypal" && from !== "src/paypal/client",
  },
  {
    name: "payments-only-in-worker",
    violates: (from, t) => t.kind === "internal" && t.id === "src/paypal/payments" && from !== "src/settlement/worker",
  },
  {
    name: "llm-no-money",
    violates: (from, t) =>
      isLlmFile(from) &&
      t.kind === "internal" &&
      ["src/paypal", "src/settlement", "src/outbox"].some((dir) => under(t.id, dir)),
  },
  {
    name: "toolkit-only-in-fulfillment",
    violates: (from, t) => t.kind === "package" && t.name === "@paypal/agent-toolkit" && from !== "src/supplier/fulfillment",
  },
  {
    name: "supplier-isolated",
    violates: (from, t) => {
      if (t.kind !== "internal") return false;
      const fromSupplier = under(from, "src/supplier");
      const toSupplier = under(t.id, "src/supplier");
      if (fromSupplier) return !toSupplier && !under(t.id, "src/protocol");
      return toSupplier;
    },
  },
  {
    name: "ai-only-in-llm-files",
    violates: (from, t) =>
      t.kind === "package" &&
      (t.name === "ai" || t.name.startsWith("@ai-sdk/")) &&
      !isLlmFile(from) &&
      from !== "src/supplier/fulfillment",
  },
];

function moduleId(path: string): string {
  return posix.normalize(path).replace(/\.(ts|tsx|js|jsx|mjs)$/, "").replace(/\/index$/, "");
}

function resolve(fromPath: string, specifier: string): Target {
  if (specifier.startsWith(".")) {
    return { kind: "internal", id: moduleId(posix.join(posix.dirname(fromPath), specifier)) };
  }
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
  return { kind: "package", name };
}

export function checkBoundaries(files: SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const from = moduleId(file.path);
    const { importedFiles } = ts.preProcessFile(file.source, true, true);
    for (const { fileName: specifier } of importedFiles) {
      const target = resolve(file.path, specifier);
      for (const rule of rules) {
        if (rule.violates(from, target)) violations.push({ rule: rule.name, file: file.path, specifier });
      }
    }
  }
  return violations;
}

export function collectSourceFiles(dirs: string[]): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist") continue;
      const path = posix.join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        files.push({ path, source: readFileSync(path, "utf8") });
      }
    }
  };
  for (const dir of dirs) if (existsSync(dir)) walk(dir);
  return files;
}
