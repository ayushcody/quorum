import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENV_KEYS } from "../src/config/env.ts";

// Every env var the code reads is documented in .env.example and declared in render.yaml.
const documented = new Set([...readFileSync(".env.example", "utf8").matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
const renderYaml = readFileSync("render.yaml", "utf8");

describe("env documentation", () => {
  it.each(ENV_KEYS.web.concat(ENV_KEYS.worker))("%s is in .env.example", (key) => {
    expect(documented.has(key)).toBe(true);
  });

  it.each(ENV_KEYS.web.concat(ENV_KEYS.worker).filter((k) => k !== "PORT"))("%s is declared in render.yaml", (key) => {
    expect(renderYaml).toMatch(new RegExp(`key: ${key}\\b`));
  });
});
