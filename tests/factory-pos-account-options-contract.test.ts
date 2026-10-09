import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const api = readFileSync(
  resolve(process.cwd(), "server/routes/factory/employee-pos/pos-financial/sales-read.ts"),
  "utf8"
);
const model = readFileSync(
  resolve(process.cwd(), "client/src/pages/factory/factorypos/useFactoryPosModel.ts"),
  "utf8"
);
const toolbar = readFileSync(
  resolve(process.cwd(), "client/src/pages/factory/factorypos/FactoryPosToolbar.tsx"),
  "utf8"
);

describe("Factory POS cash account options", () => {
  it("uses a Factory POS page-authorized, read-only, company-scoped account picker", () => {
    expect(api).toContain('app.get("/api/factory/pos/account-options", requireAuth, requireFactoryPageAccess("factory/pos")');
    expect(api).toContain("req.session.factoryCompanyId || req.session.currentCompanyId");
    expect(api).toContain("eq(ledgerAccounts.companyId, companyId)");
    expect(api).toContain("isNull(ledgerAccounts.deletedAt)");
    expect(api).toContain("eq(ledgerAccounts.active, true)");
    expect(api).toContain('inArray(ledgerAccounts.accountType, ["Cash", "Expense", "Direct Expense", "Indirect Expense"])');
    expect(api).not.toContain('app.post("/api/factory/pos/account-options"');
  });

  it("fetches POS account options without using the shared Accounting ledger endpoint", () => {
    expect(model).toContain('fetch("/api/factory/pos/account-options"');
    expect(model).toContain('queryKey: ["/api/factory/pos/account-options", selectedCompany?.id]');
    expect(model).toContain('enabled: !!selectedCompany?.id');
    expect(model).toContain('filter((a) => a.accountType === "Cash")');
    expect(model).not.toContain('"/api/ledger-accounts?includeHidden=true"');
    expect(toolbar).toContain("model.cashAccounts.map");
    expect(toolbar).toContain("model.accountOptionsError");
    expect(toolbar).toContain("No active cash accounts for this company.");
  });
});
