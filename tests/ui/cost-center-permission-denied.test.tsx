/**
 * The server decides Cost Center page ownership (ERP Accounts grant, Factory
 * Vouchers vs Daybook). A 403 must hide the panel rather than show a red error
 * or describe a permitted entry as ineligible.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { readCostCenterApi, currentRole } = vi.hoisted(() => ({
  readCostCenterApi: vi.fn(),
  currentRole: { value: "Developer" },
}));

vi.mock("@/api/costCentersApi", () => ({ readCostCenterApi, writeCostCenterApi: vi.fn() }));
vi.mock("@/contexts/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { id: 7, role: currentRole.value } }),
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
    currentRole.value = "Developer";
  });

  it.each(["Admin", "Owner", "Manager", "User", "POS"])(
    "hides both inline cost-center panels and skips API requests for %s",
    (role) => {
      currentRole.value = role;
      const voucher = wrap(<VoucherCostCenters voucherId={12} />);
      const daybook = wrap(<FactoryDaybookCostCenters entry={standalone} />);
      expect(voucher.container.textContent).toBe("");
      expect(daybook.container.textContent).toBe("");
      expect(readCostCenterApi).not.toHaveBeenCalled();
    }
  );

  it("shows voucher allocations to a Developer", async () => {
    readCostCenterApi.mockResolvedValue({
      entries: [{
        entryId: 44,
        accountName: "Fuel",
        accountCode: "EXP",
        accountType: "Expense",
        costTreatment: "EXPENSE",
        currency: "USD",
        amountNative: "50",
        amountBase: "50",
        allocatedNative: "0",
        allocatedBase: "0",
        allocationCount: 0,
      }],
    });
    wrap(<VoucherCostCenters voucherId={12} />);
    expect(await screen.findByRole("region", { name: "Voucher cost center allocations" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Assign / Split" })).toBeInTheDocument();
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
