import { describe, expect, it } from "vitest";

import { runDirectRouteBucket } from "./helpers/phase33DirectRouteHarness";

describe("Phase 33 all-route direct handler bucket 2", () => {
  it("executes its deterministic quarter of registered backend route handlers", async () => {
    const result = await runDirectRouteBucket(2, 4);
    expect(result.importedModules).toBeGreaterThan(50);
    expect(result.registerFunctions).toBeGreaterThan(20);
    expect(result.registrations).toBeGreaterThan(40);
    expect(result.invoked).toBeGreaterThan(50);
  }, 600_000);
});
