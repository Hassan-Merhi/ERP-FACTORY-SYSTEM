import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(__dirname, "..");
const src = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

describe("Factory Payroll & Benefits overview UI contract", () => {
  it("keeps the projection amount visible during refreshes instead of flashing loading dots", () => {
    const model = src("client/src/pages/factory/factorypayrolltab/useFactoryPayroll.tsx");
    const overview = src("client/src/pages/factory/factorypayrolltab/components/PayrollOverview.tsx");

    expect(model).toContain("placeholderData: keepPreviousData");
    expect(model).toContain("refetchOnWindowFocus: false");
    expect(overview).toContain("projectionRows === undefined");
    expect(overview).toContain('data-testid="stat-projection-total"');
    expect(overview).not.toContain("projectionFetching ? (");
  });

  it("preserves payroll generation, payment selection and completed batch interactions", () => {
    const overview = src("client/src/pages/factory/factorypayrolltab/components/PayrollOverview.tsx");
    expect(overview).toContain("setBulkPayOpen(true)");
    expect(overview).toContain("setRunOpen(true)");
    expect(overview).toContain("setShowCompletedBatches((v) => !v)");
    expect(overview).toContain("<BatchRow");
    expect(overview).toContain('data-testid="select-projection-period"');
  });

  it("preserves batch selection, undo, delete confirmation, and detailed columns", () => {
    const batch = src("client/src/pages/factory/factorypayrolltab/components/BatchRow.tsx");
    expect(batch).toContain("setSelectedIds((previous) =>");
    expect(batch).toContain("setDeleteBatchGroup(group)");
    expect(batch).toContain("setUndoTargetId(payroll.id)");
    expect(batch).toContain("setPayOpen(true)");
    expect(batch).toContain('minimumWidth="76rem"');
    for (const heading of ["Worker", "Present", "Absent", "Production Bonus", "Other Bonus", "Deductions", "Advances", "Net", "Status", "Paid On"]) {
      expect(batch).toContain(`>${heading}</TableHead>`);
    }
  });
});
