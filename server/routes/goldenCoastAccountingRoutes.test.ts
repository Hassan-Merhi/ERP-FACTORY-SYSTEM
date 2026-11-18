import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routeSource = readFileSync(new URL("./goldenCoastAccountingRoutes.ts", import.meta.url), "utf8");
const accessManifest = readFileSync(new URL("../../config/route-access-manifest.json", import.meta.url), "utf8");

describe("Golden Coast Phase 1 route surface", () => {
  it("registers the four protected Phase 1 endpoints", () => {
    expect(routeSource).toContain('"/api/golden-coast/accounting/phase1/setup-accounts"');
    expect(routeSource).toContain('"/api/golden-coast/accounting/phase1/accounts"');
    expect(routeSource).toContain('"/api/golden-coast/accounting/phase1/preview"');
    expect(routeSource).toContain('"/api/golden-coast/accounting/phase1/post"');
  });

  it("enforces accounting module and voucher-create permissions on live posting", () => {
    const rules = accessManifest
      .split("\n")
      .filter((line) => line.includes('"id":"') && line.includes(" /api/golden-coast/accounting"));
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) expect(rule).toContain('"mod_accounting"');
    const livePosting = rules.filter((rule) => rule.includes(" /api/golden-coast/accounting/phase1/post#"));
    expect(livePosting.length).toBeGreaterThan(0);
    for (const rule of livePosting) expect(rule).toContain('"act_create_voucher"');
  });

  it("rate-limits reads and mutations and caps request size", () => {
    expect(routeSource).toContain("privilegedReadRateLimit");
    expect(routeSource).toContain("privilegedMutationRateLimit");
    expect(routeSource).toContain("phase1RequestBudget");
  });

  it("restores inactive or soft-deleted required ledgers during setup", () => {
    expect(routeSource).toContain(".set({ active: true, deletedAt: null })");
    expect(routeSource).toContain("GOLDEN_COAST_PHASE1_LEDGER_SUBTYPES");
  });

  it("validates cash-side posting roles before central persistence", () => {
    expect(routeSource).toContain("getGoldenCoastPhase1CashRoleRequirements");
    expect(routeSource).toContain("validatePhase1CashRolesTx");
    expect(routeSource).toContain('["Cash", "Bank"]');
  });
});
