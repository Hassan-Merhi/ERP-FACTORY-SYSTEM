import { describe, expect, it } from "vitest";

import { buildErpReportCsv, erpReportFileName } from "./erpReportExports";

describe("ERP reporting exports", () => {
  it("uses safe predictable filenames without changing valid legacy prefixes", () => {
    const date = new Date(2026, 10, 9);
    expect(erpReportFileName("Daybook", "xlsx", date)).toBe("Daybook_2026-11-09.xlsx");
    expect(erpReportFileName("stock-in-sales-report", "csv", date)).toBe("stock-in-sales-report_2026-11-09.csv");
    expect(erpReportFileName("ACME / Retail", "xlsx", date)).toBe("ACME _ Retail_2026-11-09.xlsx");
  });

  it("preserves numeric accounting values and escapes quotes/newlines in CSV", () => {
    const output = buildErpReportCsv(
      ["Account", "Debit", "Credit"],
      [["Company, Ltd", -12.25, 0], ['A "quoted" note\nline two', 0, 1250.5]],
    );
    expect(output).toContain('"Company, Ltd","-12.25","0"');
    expect(output).toContain('"A ""quoted"" note\nline two","0","1250.5"');
    expect(output.split("\r\n")).toHaveLength(3);
  });

  it("treats formula-like user text as literal CSV cells without mangling numeric negatives", () => {
    const result = buildErpReportCsv(["Text", "Balance"], [["=HYPERLINK(1)", -100], [" +1+2", 30]]);
    expect(result).toContain('"\'=HYPERLINK(1)","-100"');
    expect(result).toContain('"\' +1+2","30"');
  });

  it("preserves empty-cell positions in CSV", () => {
    expect(buildErpReportCsv(["A", "B"], [[null, undefined]])).toBe('"A","B"\r\n"",""');
  });

  it("preserves historical filenames using the original separator", () => {
    const date = new Date(2026, 10, 9);
    expect(erpReportFileName("stock-in-sales-report", "xlsx", date, "-")).toBe(
      "stock-in-sales-report-2026-11-09.xlsx"
    );
  });

  it("keeps headerless financial statement metadata rows and signed numeric text", () => {
    const csv = buildErpReportCsv([], [
      ["PROVISIONAL FINANCIAL STATEMENTS — NOT CERTIFIED"],
      ["Revenue", "-1500.50", "-1200.00"],
      ["Note", "-HYPERLINK(1)", ""],
    ]);
    expect(csv.startsWith('"PROVISIONAL FINANCIAL STATEMENTS — NOT CERTIFIED"\r\n')).toBe(true);
    expect(csv).toContain('"Revenue","-1500.50","-1200.00"');
    expect(csv).toContain('"Note","\'-HYPERLINK(1)",""');
  });
});
