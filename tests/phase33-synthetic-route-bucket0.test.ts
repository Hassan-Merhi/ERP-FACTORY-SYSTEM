import { describe, expect, it } from "vitest";
import { runSyntheticRouteBucket } from "./helpers/phase33SyntheticRouteHarness";

describe("Phase 33 synthetic route bucket 0", () => {
  it("executes its deterministic backend route unit slice", async () => {
    const originalExitCode = process.exitCode;
    try {
      const result = await runSyntheticRouteBucket(0, 8);
      expect(result.importedModules).toBeGreaterThan(20);
      expect(result.registrations).toBeGreaterThan(20);
      expect(result.invoked).toBeGreaterThan(100);
    } finally {
      process.exitCode = originalExitCode;
    }
  }, 600_000);
});
