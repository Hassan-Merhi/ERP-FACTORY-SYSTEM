import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { readModuleFamily } from "../scripts/lib/readModuleFamily.mjs";

describe("Historical Replay prepare snapshot", () => {
  it("uses one repeatable-read client for preview, scope and fingerprint", () => {
    const route = readModuleFamily(
      resolve(process.cwd(), "server/routes/factory/raw-stock/historicalReplayRoutesV4.ts")
    );
    expect(route).toContain("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(route).toContain("previewHistoricalCostReplayWithExecutor(executor");
    expect(route).toContain("buildHistoricalReplayScopeInternal");
    expect(route).toContain("computeReplayFingerprint");
  });
});
