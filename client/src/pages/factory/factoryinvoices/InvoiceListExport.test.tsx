import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const exportOperationalWorkbook = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock("@/hooks/useCan", () => ({
  decideLegacyCan: () => ({ allowed: true, pending: false, reason: "allowed_by_legacy" }),
}));
vi.mock("@/contexts/CompanyContext", () => ({
  useOptionalCompany: () => ({ selectedCompany: { id: 7, role: "Admin" } }),
}));
vi.mock("@/lib/operationalExcelExport", () => ({ exportOperationalWorkbook }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { InvoiceListExport } from "./InvoiceListExport";
import type { InvoiceColumnKey } from "./InvoiceOrderRow";
import type { CustomerOrder } from "./types";

const order = (overrides: Partial<CustomerOrder>): CustomerOrder => ({
  id: 1,
  companyId: 7,
  customerId: 3,
  orderDate: "2026-11-02",
  status: "LOADING",
  subtotalBales: "0",
  freightAmount: "0",
  otherChargesTotal: "0",
  grandTotal: "0",
  totalQtyBales: 0,
  totalWeightKg: "0",
  proformaExpectedBales: "0",
  loadedNotInProformaBales: "0",
  customerName: "Customer",
  ...overrides,
});

async function exportSheet(visible: InvoiceColumnKey[], orders: CustomerOrder[]) {
  const user = userEvent.setup();
  rtlRender(
    <QueryClientProvider client={new QueryClient()}>
      <InvoiceListExport
        orders={orders}
        isColumnVisible={(key) => visible.includes(key)}
        formatDisplayDate={(date) => `d:${date}`}
        period={{ from: "2026-11-01", to: "2026-11-30" }}
      />
    </QueryClientProvider>
  );
  await user.click(screen.getByTestId("button-export-invoices"));
  await user.click(await screen.findByTestId("export-option-excel"));
  await waitFor(() => expect(exportOperationalWorkbook).toHaveBeenCalledTimes(1));
  return exportOperationalWorkbook.mock.calls[0][0];
}

describe("Factory Invoices Excel export", () => {
  beforeEach(() => exportOperationalWorkbook.mockClear());

  it("writes the listed orders with only the columns the column picker shows", async () => {
    const input = await exportSheet(
      ["loading", "status", "bales", "remaining", "total"],
      [
        order({
          id: 11,
          customerName: "Acme",
          status: "VERIFIED",
          totalQtyBales: 40,
          proformaExpectedBales: "50",
          grandTotal: "1250.5",
        }),
        order({
          id: 12,
          customerName: "Bolt",
          status: "FINALIZED",
          totalQtyBales: 52,
          proformaExpectedBales: "50",
          grandTotal: "900",
        }),
        order({ id: 13, customerName: "Cora", status: "LOADING", totalQtyBales: 5 }),
      ]
    );
    expect(input.fileName).toBe("factory-invoices_2026-11-01_2026-11-30.xlsx");
    const sheet = input.sheets[0];
    expect(sheet.columns.map((column: { header: string }) => column.header)).toEqual([
      "Customer",
      "Loading #",
      "Status",
      "Bales",
      "Remaining",
      "Total (USD)",
    ]);
    expect(sheet.rows).toEqual([
      { c0: "Acme", c1: "#11", c2: "Verified", c3: 40, c4: 10, c5: 1250.5 },
      { c0: "Bolt", c1: "#12", c2: "Finalized", c3: 52, c4: "+2", c5: 900 },
      { c0: "Cora", c1: "#13", c2: "Loading", c3: 5, c4: null, c5: 0 },
    ]);
  });

  it("splits extras into freight and other charges and formats dates as the table does", async () => {
    const input = await exportSheet(
      ["date", "extras"],
      [order({ id: 21, customerName: "Dune", freightAmount: "300", otherChargesTotal: "0", orderDate: "2026-11-05" })]
    );
    const sheet = input.sheets[0];
    expect(sheet.columns.map((column: { header: string }) => column.header)).toEqual([
      "Customer",
      "Date",
      "Freight (USD)",
      "Other charges (USD)",
    ]);
    expect(sheet.rows[0]).toEqual({ c0: "Dune", c1: "d:2026-11-05", c2: 300, c3: null });
  });
});
