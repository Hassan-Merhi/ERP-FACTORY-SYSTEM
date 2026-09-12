import { describe, expect, it } from "vitest";
import {
  classifyFinalVerification,
  exactCutoverConfirmation,
  exactInventoryValue,
  latestCutoverBlocksCompany,
  numbersDiffer,
} from "../spMigrationPhase4Policy";

describe("Supplier Partner Phase 4 policy", () => {
  it("classifies blockers as FAIL", () => {
    expect(classifyFinalVerification([{ code: "X", message: "blocked" }], [])).toBe("FAIL");
  });

  it("classifies unresolved deltas as WARN", () => {
    expect(classifyFinalVerification([], [{ code: "D", message: "delta" }])).toBe("WARN");
  });

  it("classifies a clean report as PASS", () => {
    expect(classifyFinalVerification([], [])).toBe("PASS");
  });

  it("requires exact cutover text and company name", () => {
    expect(exactCutoverConfirmation("FINALIZE CUTOVER", "FINALIZE CUTOVER", "GC Lshi", "GC Lshi")).toBeNull();
    expect(exactCutoverConfirmation("finalize", "FINALIZE CUTOVER", "GC Lshi", "GC Lshi")).toContain("FINALIZE CUTOVER");
    expect(exactCutoverConfirmation("FINALIZE CUTOVER", "FINALIZE CUTOVER", "GC", "GC Lshi")).toContain("GC Lshi");
  });

  it("preserves the stored inventory total value", () => {
    expect(exactInventoryValue("10", "2.50", "24.99")).toBe(24.99);
  });

  it("falls back to quantity times rate only when total value is absent", () => {
    expect(exactInventoryValue("10", "2.50", null)).toBe(25);
  });

  it("compares numbers using the requested tolerance", () => {
    expect(numbersDiffer(1, 1.00001, 0.0001)).toBe(false);
    expect(numbersDiffer(1, 1.001, 0.0001)).toBe(true);
  });

  it("locks the source while prepared or active", () => {
    expect(latestCutoverBlocksCompany({ companyId: 1, sourceCompanyId: 1, targetCompanyId: 2, status: "prepared" }).blocked).toBe(true);
    expect(latestCutoverBlocksCompany({ companyId: 1, sourceCompanyId: 1, targetCompanyId: 2, status: "active" }).blocked).toBe(true);
  });

  it("locks the target while prepared", () => {
    expect(latestCutoverBlocksCompany({ companyId: 2, sourceCompanyId: 1, targetCompanyId: 2, status: "prepared" }).code).toBe("SP_TARGET_CUTOVER_LOCKED");
  });

  it("holds the target read-only after rollback", () => {
    expect(latestCutoverBlocksCompany({ companyId: 2, sourceCompanyId: 1, targetCompanyId: 2, status: "rolled_back", targetWriteHold: true }).code).toBe("SP_TARGET_POST_ROLLBACK_HOLD");
  });
});
