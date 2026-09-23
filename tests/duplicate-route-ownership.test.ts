import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

describe("Phase 8 duplicate route ownership", () => {
  it("registers each focused application registrar only once", () => {
    const applicationRoutes = read("server/routes/applicationRoutes.ts");
    const names = Array.from(
      applicationRoutes.matchAll(/(register[A-Z][A-Za-z0-9]+Routes?)\(app/g),
      (match) => match[1]
    );
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index);

    expect(names.length).toBeGreaterThan(0);
    expect([...new Set(duplicates)]).toEqual([]);
  });

  it("keeps retired compatibility files and migration-only boundary tooling deleted", () => {
    const files = [
      "server/routesLegacy.ts",
      "server/routes/reportsRoutesLegacy.ts",
      "server/routes/authRoutesLegacy.ts",
      "server/routes/customerRoutesLegacy.ts",
      "config/legacy-route-boundaries.json",
      "scripts/audit-legacy-route-boundaries.mjs",
      "tests/legacy-route-boundaries.test.ts",
    ];

    for (const file of files) {
      expect(fs.existsSync(path.join(root, file)), `${file} should remain retired`).toBe(false);
    }
  });
});
