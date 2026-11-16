/**
 * The startup preload manifest (server/startupPreload.mjs) is the single place
 * that decides what runs before the server entrypoint and in which order.
 *
 *   - Production and development start through it; production adds the
 *     runtime guards as a second, later --import.
 *   - The read-only schema gate runs first after configuration checks: a
 *     database that does not match this release's migrations stops startup
 *     before anything else touches it.
 *   - Nothing in the chain changes the schema. Schema "bridges"
 *     (server/*Bridge.mjs) no longer exist; migrations/ owns the schema.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

/** Every `await import("./x")`, whether bare or destructured, in order. */
function awaitedImports(file: string): string[] {
  return [...read(file).matchAll(/await import\("\.\/([^"]+)"\)/g)].map((match) => match[1]);
}

describe("startup preload manifest", () => {
  it("is what production and development start with", () => {
    const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
    expect(scripts.start).toBe(
      "node --expose-gc --import ./server/startupPreload.mjs --import ./server/runtimeMemoryGuard.mjs dist/index.js"
    );
    expect(scripts.dev).toContain("--import ./server/startupPreload.mjs ");
    expect(read(".github/workflows/ui-quality.yml")).toContain("--import ./server/startupPreload.mjs");
  });

  it("verifies the schema read-only before any other database work, then runs data operations and runtime patches", () => {
    expect(awaitedImports("server/startupPreload.mjs")).toEqual([
      "deploymentPreflight.mjs",
      "schema/startupSchemaGate.mjs",
      "startup/startupDataOperations.mjs",
      "runtime/fxFetchTimeout.mjs",
      "runtime/exportBuffer.mjs",
      "runtime/scheduledAttachment.mjs",
      "runtime/apiPagination.mjs",
    ]);
    const source = read("server/startupPreload.mjs");
    expect(source).toContain("await runStartupSchemaGateOnce();");
    expect(source.indexOf("runStartupSchemaGateOnce()")).toBeLessThan(source.indexOf("runStartupDataOperations()"));
    expect(source).not.toMatch(/^import\s+["']/m);
  });

  it("has no schema bridges and no schema preload left", () => {
    const leftovers = fs
      .readdirSync(path.join(root, "server"))
      .filter((file) => /Bridge\.mjs$|^schemaPreload\.mjs$/.test(file));
    expect(leftovers).toEqual([]);
    expect(fs.existsSync(path.join(root, "server/startup-schema"))).toBe(false);
  });

  it("the server pool module does not import any startup side effects", () => {
    expect(read("server/db.ts")).not.toMatch(/^import\s+["']\.\/[^"']+["'];$/m);
  });
});
