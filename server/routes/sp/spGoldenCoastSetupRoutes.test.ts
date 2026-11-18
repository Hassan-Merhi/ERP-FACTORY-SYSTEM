import { describe, expect, it } from "vitest";
import { readModuleFamily } from "../../../scripts/lib/readModuleFamily.mjs";

const routeSource = readModuleFamily(new URL("./spGoldenCoastSetupRoutes.ts", import.meta.url));
const spSetupSource = readModuleFamily(new URL("./spSetupRoutes.ts", import.meta.url));
const spIndexSource = readModuleFamily(new URL("./index.ts", import.meta.url));

describe("Golden Coast setup route surface hardened by Phase 13", () => {
  it("keeps provisioning and status inside the Supplier Partner setup area", () => {
    expect(routeSource).toContain('"/api/sp/setup/golden-coast"');
    expect(routeSource).toContain('"/api/sp/setup/golden-coast/status"');
    expect(spIndexSource).toContain("registerSpGoldenCoastSetupRoutes(app);");
  });

  it("restricts provisioning to authenticated Admins on a supplier_partner company", () => {
    expect(routeSource).toContain("requireAuth");
    expect(routeSource).toContain('requireRole("Admin")');
    expect(routeSource).toContain("requireSpCompany(req, res)");
  });

  it("rate limits both endpoints and caps the provisioning request body", () => {
    expect(routeSource).toContain("privilegedMutationRateLimit");
    expect(routeSource).toContain("privilegedReadRateLimit");
    expect(routeSource).toContain("goldenCoastRequestBudget");
  });

  it("keeps Phase 2 ledger reads and writes scoped to the selected company", () => {
    expect(routeSource).toContain("eq(ledgerAccounts.companyId, companyId)");
    expect(routeSource).toContain("eq(companySettings.companyId, companyId)");
    expect(routeSource).toContain(
      "and(eq(ledgerAccounts.id, item.accountId), eq(ledgerAccounts.companyId, companyId))"
    );
  });

  it("provisions both stable Phase 7 intercompany subtypes without changing Phase 7 transfer workflows", () => {
    expect(routeSource).toContain("goldenCoastPhase13IntercompanyDefinitions");
    expect(routeSource).toContain("defs.golden_coast_hadi");
    expect(routeSource).toContain("defs.hadi_golden_coast");
    expect(routeSource).toContain("applyIntercompanyPlan");
    expect(routeSource).not.toContain("buildGoldenCoastPhase7TransferPostings");
  });

  it("requires tenant-boundary authorization before switching to HADI", () => {
    expect(routeSource).toContain("getCompanyRequestRuntimeContext");
    expect(routeSource).toContain("authorizedCompanyIds?.includes(pair.hadiCompanyId)");
    expect(routeSource).toContain("GC_PHASE13_HADI_SCOPE_UNAUTHORIZED");
    expect(routeSource).toContain("targetCompanyId=${pair.hadiCompanyId}");
    expect(routeSource).toContain("assertTransactionCompanyScope(tx, pair.hadiCompanyId)");
    expect(routeSource).toContain("assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId)");
  });

  it("repairs reciprocal accounts in place instead of deleting ledger history", () => {
    expect(routeSource).toContain("planGoldenCoastPhase13IntercompanyAccount");
    expect(routeSource).toContain("patch[repair.field] = repair.to");
    expect(routeSource).toContain('openingBalanceSide: "Cr"');
    expect(routeSource).not.toContain(".delete(");
    expect(routeSource).not.toContain("voucherEntries");
  });

  it("exposes Phase 13 intercompany blockers from the Golden Coast status endpoint", () => {
    expect(routeSource).toContain("phase13Status");
    expect(routeSource).toContain("parentAuthorized");
    expect(routeSource).toContain("hadiAccount: null");
    expect(routeSource).toContain("blockers");
  });

  it("applies Phase 2 and Phase 13 provisioning atomically", () => {
    expect(routeSource).toContain("db.transaction(async (tx)");
  });

  it("preserves the existing embedded Phase 2 status for legacy setup consumers", () => {
    expect(spSetupSource).toContain("summarizeGoldenCoastAccountSetup");
    expect(spSetupSource).toContain("goldenCoast,");
  });

  it("keeps legacy SP setup idempotent when a company already has a matching account name or code", () => {
    expect(spSetupSource).toContain("const liveAccountNames = new Set");
    expect(spSetupSource).toContain("const [codeCollision]");
    expect(spSetupSource).toContain("name = `${acct.name} (${acct.code})`");
  });
});
