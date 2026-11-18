import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const canState = vi.hoisted(() => ({ allowed: true }));
const exportOperationalWorkbook = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const toast = vi.hoisted(() => vi.fn());

const decideLegacyCan = vi.hoisted(() =>
  vi.fn(() => ({ allowed: canState.allowed, pending: false, reason: "allowed_by_legacy" }))
);
vi.mock("@/hooks/useCan", () => ({ decideLegacyCan }));
vi.mock("@/contexts/CompanyContext", () => ({
  useOptionalCompany: () => ({ selectedCompany: { id: 7, role: "Admin" } }),
}));
vi.mock("@/lib/operationalExcelExport", () => ({ exportOperationalWorkbook }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { RowsExportMenu } from "./RowsExportMenu";

function render(ui: ReactElement) {
  return rtlRender(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

type Row = { code: string; qty: string | number; note?: string | null };

const columns = [
  { header: "Code", value: (row: Row) => row.code },
  { header: "Quantity", value: (row: Row) => row.qty, type: "number" as const },
  { header: "Note", value: (row: Row) => row.note },
];

async function chooseExcel() {
  const user = userEvent.setup();
  await user.click(screen.getByTestId("button-export-menu"));
  await user.click(await screen.findByTestId("export-option-excel"));
}

describe("RowsExportMenu", () => {
  beforeEach(() => {
    canState.allowed = true;
    exportOperationalWorkbook.mockClear();
    exportOperationalWorkbook.mockResolvedValue([]);
    toast.mockClear();
  });

  it("is hidden for users who may not export Excel and checks the page's resource", () => {
    canState.allowed = false;
    render(<RowsExportMenu title="Stock Transfers" rows={[]} columns={columns} resource="erp.stock_transfers" />);
    expect(screen.queryByTestId("button-export-menu")).not.toBeInTheDocument();
    expect(decideLegacyCan).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 7,
        role: "Admin",
        resource: "erp.stock_transfers",
        action: "export",
        legacyAllowed: true,
        featureKey: "exp_excel",
      })
    );
  });

  it("is disabled when the page shows no rows", () => {
    render(<RowsExportMenu title="Stock Transfers" rows={[]} columns={columns} resource="erp.stock_transfers" />);
    expect(screen.getByTestId("button-export-menu")).toBeDisabled();
  });

  it("writes exactly the given rows and columns, with numeric cells and a dated file name", async () => {
    const rows: Row[] = [
      { code: "A-1", qty: "12.5", note: "first" },
      { code: "B-2", qty: 3, note: null },
    ];
    render(
      <RowsExportMenu
        title="Stock Transfers"
        rows={rows}
        columns={columns}
        resource="erp.stock_transfers"
        period={{ from: "2026-11-01", to: "2026-11-17" }}
        filters={[{ label: "Location", value: "Main" }]}
      />
    );
    await chooseExcel();
    await waitFor(() => expect(exportOperationalWorkbook).toHaveBeenCalledTimes(1));
    const input = exportOperationalWorkbook.mock.calls[0][0];
    expect(input.fileName).toBe("stock-transfers_2026-11-01_2026-11-17.xlsx");
    expect(input.filters).toEqual([{ label: "Location", value: "Main" }]);
    expect(input.sheets).toHaveLength(1);
    expect(input.sheets[0].columns.map((column: { header: string }) => column.header)).toEqual([
      "Code",
      "Quantity",
      "Note",
    ]);
    expect(input.sheets[0].rows).toEqual([
      { c0: "A-1", c1: 12.5, c2: "first" },
      { c0: "B-2", c1: 3, c2: null },
    ]);
  });

  it("shows the standard failure toast when the workbook cannot be built", async () => {
    exportOperationalWorkbook.mockRejectedValueOnce(new Error("boom"));
    render(
      <RowsExportMenu title="Bale Ledger" rows={[{ code: "X", qty: 1 }]} columns={columns} resource="erp.inventory" />
    );
    await chooseExcel();
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Export failed", description: "boom" }))
    );
  });
});

describe("buildRowsExportSheet", () => {
  it("produces a sheet the universal Excel engine accepts, with blanks, numeric text and a total row", async () => {
    const { buildRowsExportSheet } = await import("./RowsExportMenu");
    const { buildUniversalExcelWorkbook } = await import("@shared/universal-excel/engine");
    const sheet = buildRowsExportSheet<Row>({
      name: "Stock",
      rows: [
        { code: "A-1", qty: "1234.5", note: "=SUM(A1)" },
        { code: "B-2", qty: "not a number", note: undefined },
      ],
      columns,
      footer: ["Total", 1234.5, null],
    });
    expect(sheet.rows[1]).toEqual({ c0: "B-2", c1: null, c2: null });
    expect(sheet.footer).toEqual({ c0: "Total", c1: 1234.5, c2: null });
    const { results } = buildUniversalExcelWorkbook({
      schemaVersion: 1,
      title: "Stock",
      mode: "report",
      sheets: [{ kind: "table", strictColumns: true, ...sheet }],
    });
    expect(results).toHaveLength(1);
  });
});

describe("excelSheetName", () => {
  it("makes labels with characters Excel forbids into valid, unique worksheet names", async () => {
    const { excelSheetName } = await import("./RowsExportMenu");
    const { assertSheetName } = await import("@shared/universal-excel/engineAsCell");
    const used = new Set<string>();
    const names = [
      "Items - Average Profit / Bale",
      "Q1: [draft] *final*?",
      "'Quoted'",
      "A very long worksheet title that runs past the limit",
      "A very long worksheet title that runs past the limit",
      "",
    ].map((name) => excelSheetName(name, used));

    expect(names[0]).toBe("Items - Average Profit - Bale");
    expect(names[2]).toBe("Quoted");
    expect(names[3]).toHaveLength(31);
    expect(names[4]).toMatch(/ \(2\)$/);
    expect(names[5]).toBe("Sheet");
    const seen = new Set<string>();
    for (const name of names) expect(() => assertSheetName(name, seen)).not.toThrow();
  });
});
