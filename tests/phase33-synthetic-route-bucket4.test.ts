import { describe, expect, it, vi } from "vitest";

describe("Phase 33 synthetic route bucket 4", () => {
  it("executes its deterministic backend route unit slice", async () => {
    const originalExitCode = process.exitCode;
    try {
      vi.resetModules();
      const { runSyntheticRouteBucket } = await import("./helpers/phase33SyntheticRouteHarness");
      const result = await runSyntheticRouteBucket(4, 8);
      expect(result.importedModules).toBeGreaterThan(20);
      expect(result.registrations).toBeGreaterThan(20);
      expect(result.invoked).toBeGreaterThan(100);
    } finally {
      process.exitCode = originalExitCode;
      vi.resetModules();
    }
  }, 600_000);
});
