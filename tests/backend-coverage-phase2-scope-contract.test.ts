import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { selectPhase2ImportValidationRoutes } from "./backend-coverage-phase2-import-validation-sweep.test";

type Manifest = { routes: string[] };

const MANIFEST_PATH = path.join(process.cwd(), "config/route-manifest.json");

describe("Phase 2 coverage sweep scope", () => {
  it("keeps import validation coverage represented across every company mode", () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
    const routes = selectPhase2ImportValidationRoutes(manifest);
    const modes = new Set(routes.map((route) => route.mode));

    expect(routes.length).toBeGreaterThan(15);
    expect(modes).toEqual(new Set(["erp", "factory", "properties", "supplier_partner"]));
  });
});
