import { describe, expect, it } from "vitest";
import {
  isDeveloperOnlyAccountingPath,
  normalizedAccountingPath,
} from "../server/middleware/unifiedAccountingRolloutBoundary";

describe("Admin/Owner voucher FX correction path isolation", () => {
  it("allows exactly the audited correction GET and POST URL shapes through the global Developer rollout gate", () => {
    expect(isDeveloperOnlyAccountingPath(
      normalizedAccountingPath("/api/accounting/monetary-fx/revaluation/123/correction-preview")
    )).toBe(false);
    expect(isDeveloperOnlyAccountingPath(
      normalizedAccountingPath("/API/accounting/monetary-fx/revaluation/123/correct/")
    )).toBe(false);
  });
  it("keeps all other unified accounting endpoints Developer-only", () => {
    for (const path of [
      "/api/accounting/monetary-fx/rates",
      "/api/accounting/monetary-fx/realized/1/recognize",
      "/api/accounting/monetary-fx/revaluation/x/correct",
      "/api/accounting/monetary-fx/revaluation/123/correct/extra",
      "/api/accounting/monetary-fx/revaluation/123/correction-preview-copy",
      "/api/accounting/unified-dashboard",
    ]) {
      expect(isDeveloperOnlyAccountingPath(normalizedAccountingPath(path)), path).toBe(true);
    }
  });
});
