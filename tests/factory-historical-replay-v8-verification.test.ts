import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Historical Replay V8 exact verification", () => {
  it("registers verification before the exact apply and legacy route layers", () => {
    const registration = read("server/routes/factory/raw-stock/rawStockRecalcRoutes.ts");
    const verificationIndex = registration.indexOf("registerHistoricalReplayPhase8VerificationRoutes(app)");
    const exactIndex = registration.indexOf("registerHistoricalReplayRoutesV4(app)");
    const legacyIndex = registration.indexOf("registerLegacyRawStockRecalcRoutes(app)");

    expect(verificationIndex).toBeGreaterThan(-1);
    expect(verificationIndex).toBeLessThan(exactIndex);
    expect(exactIndex).toBeLessThan(legacyIndex);
  });

  it("uses one repeatable-read read-only snapshot and exact stored invariants", () => {
    const verification = read("server/routes/factory/raw-stock/historicalReplayVerificationRoutes.ts");
    expect(verification).toContain("REPEATABLE READ READ ONLY");
    expect(verification).toContain("captureExactReplaySnapshot");
    expect(verification).toContain("assertExactReplayNonCostInvariants");
    expect(verification).toContain("assertExactReplayCurrentCostsMatchApplied");
    expect(verification).toContain("row.undone_at ? envelope.before : envelope.after");
    expect(verification).toContain("scope_fingerprint");
    expect(verification).toContain("REPLAY_ALGORITHM_VERSION");
  });

  it("contains no replay, undo, schema, or accounting write statement", () => {
    const verification = read("server/routes/factory/raw-stock/historicalReplayVerificationRoutes.ts");
    expect(verification).not.toMatch(/\bUPDATE\b|\bINSERT\b|\bDELETE\b|\bALTER\b|\bCREATE\b/i);
    expect(verification).not.toContain("applyHistoricalCostReplay(");
    expect(verification).not.toContain("restoreExactReplayCosts(");
  });
});
