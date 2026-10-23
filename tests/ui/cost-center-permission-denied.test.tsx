/**
 * The server decides Cost Center page ownership (ERP Accounts grant, Factory
 * Vouchers vs Daybook). A 403 must hide the panel rather than show a red error
 * or describe a permitted entry as ineligible.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { readCostCenterApi } = vi.hoisted(() => ({ readCostCenterApi: vi.fn() }));

vi.mock("@/api/costCentersApi", () => ({ readCostCenterApi, writeCostCenterApi: vi.fn() }));
vi.mock("@/contexts/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { id: 7, role: "Manager" } }),
}));
vi.mock("@/contexts/AppModeContext", () => ({ useAppMode: () => "factory" }));
vi.mock("@/lib/queryClient", () => ({ queryClient: { invalidateQueries: vi.fn() } }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { VoucherCostCenters } from "@/components/financial/VoucherCostCenters";
import { FactoryDaybookCostCenters } from "@/pages/factory/daybook/FactoryDaybookCostCenters";
import type { DaybookEntry } from "@/pages/factory/daybook/types";

function wrap(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

function denied() {
  return Object.assign(new Error("You do not have access to this Factory page."), { status: 403 });
}

const standalone = {
  id: 41,
  txType: "EXPENSE",
  referenceTable: null,
  referenceId: null,
  description: "Diesel",
  currencyCode: "USD",
  amountCurrency: 25,
  amountUsd: 25,
} as unknown as DaybookEntry;

describe("Cost Center panels when the server denies the page", () => {
  beforeEach(() => {
    readCostCenterApi.mockReset();
  });

  it("hides voucher allocations for a viewer without the owning page", async () => {
    readCostCenterApi.mockImplementation(async () => {
      throw denied();
    });
    const { container } = wrap(<VoucherCostCenters voucherId={12} />);
    await waitFor(() => expect(readCostCenterApi).toHaveBeenCalledWith("/api/factory/cost-centers/voucher/12/entries"));
    await waitFor(() => expect(container.textContent).toBe(""));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("still reports genuine voucher allocation failures", async () => {
    readCostCenterApi.mockImplementation(async () => {
      throw Object.assign(new Error("Server error"), { status: 500 });
    });
    wrap(<VoucherCostCenters voucherId={12} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Server error");
  });

  it("hides a standalone Daybook allocation for a viewer without Daybook or Finance", async () => {
    readCostCenterApi.mockImplementation(async () => {
      throw denied();
    });
    const { container } = wrap(<FactoryDaybookCostCenters entry={standalone} />);
    await waitFor(() =>
      expect(readCostCenterApi).toHaveBeenCalledWith("/api/factory/cost-centers/allocations/factory_daybook/41")
    );
    await waitFor(() => expect(container.textContent).toBe(""));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the ineligible-entry message for non-permission errors", async () => {
    readCostCenterApi.mockImplementation(async () => {
      throw Object.assign(new Error("Not standalone"), { status: 409 });
    });
    wrap(<FactoryDaybookCostCenters entry={standalone} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("not available for independent cost-center allocation");
  });
});
