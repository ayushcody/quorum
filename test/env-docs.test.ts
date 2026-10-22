import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENV_KEYS } from "../src/config/env.ts";

// Every env var the code reads is documented in .env.example and declared in render.yaml.
const readKeys = [...new Set([...ENV_KEYS.web, ...ENV_KEYS.worker])];
const documented = new Set([...readFileSync(".env.example", "utf8").matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
const renderYaml = readFileSync("render.yaml", "utf8");

describe("env documentation", () => {
  it("every key the code reads is in .env.example", () => {
    expect(readKeys.filter((key) => !documented.has(key))).toEqual([]);
  });

  it("every key except PORT (Render sets it) is declared in render.yaml", () => {
    const missing = readKeys.filter((key) => key !== "PORT" && !new RegExp(`key: ${key}\\b`).test(renderYaml));
    expect(missing).toEqual([]);
  });
});
