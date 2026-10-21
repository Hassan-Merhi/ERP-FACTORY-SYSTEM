import React from "react";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  queryOptions: [] as any[],
  invalidateQueries: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: any) => {
    harness.queryOptions.push(options);
    return { data: [], isFetched: true, isLoading: false };
  },
  useQueryClient: () => ({ invalidateQueries: harness.invalidateQueries }),
}));

vi.mock("@/lib/queryKeys", () => ({
  stockItemKeys: {
    identity: (companyId?: number) => ["/api/stock-items/light", companyId],
  },
}));

import { useVoucherQueries } from "@/pages/vouchers/useVoucherQueries";

function HookHarness({ activeTab }: { activeTab: string }) {
  useVoucherQueries({
    selectedCompany: { id: 4, companyType: "trading" },
    isFactoryCompany: false,
    isPropertiesCompany: false,
    voucherIdToEdit: 90,
    accountPickersNeeded: true,
    activeTab,
    isPOS: false,
  });
  return null;
}

function optionFor(firstKey: string) {
  return harness.queryOptions.find((options) => options.queryKey?.[0] === firstKey);
}

describe("voucher stock-transfer query behavior", () => {
  beforeEach(() => {
    harness.queryOptions.length = 0;
    harness.invalidateQueries.mockReset();
    harness.invalidateQueries.mockResolvedValue(undefined);
  });

  it("keeps Normal Stock Transfer lightweight and refreshes the exact saved transfer state", async () => {
    render(<HookHarness activeTab="transfer" />);

    expect(optionFor("/api/bank-accounts")?.enabled).toBe(false);
    expect(optionFor("/api/ledger-accounts?profile=voucher-picker&includeHidden=true&companyId=4")?.enabled).toBe(
      false
    );
    expect(optionFor("/api/suppliers")?.enabled).toBe(false);
    expect(optionFor("/api/customers")?.enabled).toBe(false);
    expect(optionFor("/api/employees")?.enabled).toBe(false);
    expect(optionFor("/api/fixed-assets")?.enabled).toBe(false);
    expect(optionFor("/api/accounts/voucher-sidebar")?.enabled).toBe(false);
    expect(optionFor("/api/stock-items/light")?.enabled).toBe(false);
    expect(optionFor("/api/locations")?.enabled).toBe(false);
    expect(optionFor("/api/vouchers")?.enabled).toBe(false);

    await waitFor(() => {
      expect(harness.invalidateQueries).toHaveBeenCalledWith({
        queryKey: ["/api/stock-transfers", 90],
        exact: true,
        refetchType: "active",
      });
      expect(harness.invalidateQueries).toHaveBeenCalledWith({
        queryKey: ["/api/vouchers", 90],
        exact: true,
        refetchType: "active",
      });
    });
  });

  it("refreshes again when switching between Transfer Order and Normal View", async () => {
    const { rerender } = render(<HookHarness activeTab="transferorder" />);

    await waitFor(() => expect(harness.invalidateQueries).toHaveBeenCalledTimes(2));
    harness.invalidateQueries.mockClear();

    rerender(<HookHarness activeTab="transfer" />);

    await waitFor(() => expect(harness.invalidateQueries).toHaveBeenCalledTimes(2));
  });
});
