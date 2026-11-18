import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { readModuleFamily } from "../scripts/lib/readModuleFamily.mjs";

describe("Historical Replay atomic audit", () => {
  it("persists undo and audit from the apply transaction callback", () => {
    const route = readModuleFamily(
      resolve(process.cwd(), "server/routes/factory/raw-stock/historicalReplayRoutesV4.ts")
    );
    expect(route).toContain("onCommit: async (client, applyResult, snapshots)");
    expect(route).toContain("INSERT INTO factory_recalc_undo_log");
    expect(route).toContain("INSERT INTO audit_log");
    expect(route).toContain("before: snapshots.before");
    expect(route).toContain("after: snapshots.after");
  });
});
