import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Historical Replay prepare guard", () => {
  const source = readFileSync(
    resolve(process.cwd(), "server/routes/factory/raw-stock/historicalReplayGuardRoutes.ts"),
    "utf8"
  );

  it("rejects empty supplier scope instead of defaulting to all suppliers", () => {
    expect(source).toContain("HISTORICAL_REPLAY_EMPTY_SCOPE");
    expect(source).toContain("supplierIds.length === 0");
  });

  it("rejects token plus dry-run mode", () => {
    expect(source).toContain("HISTORICAL_REPLAY_CONFLICTING_MODE");
    expect(source).toContain("req.body?.dryRun === true");
  });
});
