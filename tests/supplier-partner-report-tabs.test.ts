import { describe, expect, it } from "vitest";
import path from "node:path";
import { readModuleFamily } from "../scripts/lib/readModuleFamily.mjs";

const reportsPath = path.resolve(process.cwd(), "client/src/pages/sp/SpReports.tsx");
const reportsSource = readModuleFamily(reportsPath);

describe("Supplier Partner report tab navigation", () => {
  it("uses validated URL-backed tab state", () => {
    expect(reportsSource).toContain("useHubQueryState<ReportTab>");
    expect(reportsSource).toContain('const REPORT_TABS = ["profit", "sales-form"] as const');
    expect(reportsSource).toContain('defaultValue: "profit"');
    expect(reportsSource).toContain("omitDefault: true");
    expect(reportsSource).toContain("<Tabs value={tab}");
    expect(reportsSource).toContain("onValueChange={(value) => setTab(value as ReportTab)}");
  });

  it("keeps the default report URL clean and exposes canonical deep links", () => {
    expect(reportsSource).toContain('<TabsTrigger value="profit"');
    expect(reportsSource).toContain('<TabsTrigger value="sales-form"');
    expect(reportsSource).toContain('<TabsContent value="profit"');
    expect(reportsSource).toContain('<TabsContent value="sales-form"');
  });

  it("preserves all report and export contracts", () => {
    expect(reportsSource).toContain("/api/sp/report/profit");
    expect(reportsSource).toContain('const splitsUrl = "/api/sp/profit-splits"');
    expect(reportsSource).not.toContain('apiRequest("POST", "/api/sp/profit-splits"');
    expect(reportsSource).toContain("QuickMonthlyClose");
    expect(reportsSource).toContain('periodMonth={endDate.length >= 7 ? endDate.slice(0, 7) : ""}');
    expect(reportsSource).toContain("/api/sp/sales-form/export?");
    expect(reportsSource).toContain("/api/sp/sales-form/export-v2?");
    expect(reportsSource).toContain('["/api/accounts/all", selectedCompany?.id]');
    expect(reportsSource).toContain("const accounts = extractAccounts(accountsResponse)");
    expect(reportsSource).toContain("payload?.accounts");
  });
});
