import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { readModuleFamily } from "../scripts/lib/readModuleFamily.mjs";

describe("Historical Replay stale undo", () => {
  it("compares current costs and non-cost state before restoring", () => {
    const route = readModuleFamily(
      resolve(process.cwd(), "server/routes/factory/raw-stock/historicalReplayRoutesV4.ts")
    );
    expect(route).toContain("assertExactReplayNonCostInvariants(envelope.after, current)");
    expect(route).toContain("assertExactReplayCurrentCostsMatchApplied(envelope.after, current)");
    expect(route).toContain("undone_at IS NULL");
  });
});
