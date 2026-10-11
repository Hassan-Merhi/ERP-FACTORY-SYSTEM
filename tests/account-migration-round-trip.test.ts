import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

const adminRoutes = readFileSync("server/routes/adminRoutes.ts", "utf8");
const roundTripRoutes = readFileSync("server/routes/admin/accountMigrationRoundTripRoutes.ts", "utf8");

describe("account migration round-trip safety", () => {
  it("registers the transaction-aware move-back handler before the normal undo handler", () => {
    expect(adminRoutes).toContain("registerAccountMigrationRoundTripRoutes(app)");
    expect(adminRoutes.indexOf("registerAccountMigrationRoundTripRoutes(app)")).toBeLessThan(
      adminRoutes.indexOf("registerAccountMigrationSafeRoutes(app)")
    );
  });

  it("uses the normal exact undo when there was no destination-company activity", () => {
    expect(roundTripRoutes).toContain("if (postMigrationVoucherIds.length === 0) return next()");
  });

  it("reverse-migrates current voucher history after new destination activity", () => {
    expect(roundTripRoutes).toContain("buildMigrationVoucherPlan");
    expect(roundTripRoutes).toContain("movedBackVoucherIds");
    expect(roundTripRoutes).toContain("splitBackVoucherIds");
    expect(roundTripRoutes).toContain("postMigrationVoucherIds");
    expect(roundTripRoutes).toContain('mode: "round_trip_return"');
  });

  // Both steps run in one transaction, so the committed result is the same in
  // either order. Since the 2026-10 ledger integrity guard checks every written
  // line against its account's company, the account must be back in the
  // original company before the split writes lines that reference it there.
  it("moves the account back before destination entries are split, in the same transaction", () => {
    const entrySplit = roundTripRoutes.indexOf("splitBackVoucherIds.push(destinationVoucher.id)");
    const accountMove = roundTripRoutes.indexOf(".set({ companyId: srcCompanyId, code: savedAccount.originalCode");
    expect(entrySplit).toBeGreaterThan(-1);
    expect(accountMove).toBeGreaterThan(-1);
    expect(accountMove).toBeLessThan(entrySplit);
  });

  it("restores the original account code and source-company control mappings", () => {
    expect(roundTripRoutes).toContain("code: savedAccount.originalCode");
    expect(roundTripRoutes).toContain("restoreAccountMigrationControlReferences(tx, srcCompanyId, saved.controls)");
  });
});
