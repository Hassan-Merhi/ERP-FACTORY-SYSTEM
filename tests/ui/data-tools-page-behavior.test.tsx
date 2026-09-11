import React, { createContext, useContext } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  toast: vi.fn(),
  apiRequest: vi.fn(),
  modeApiRequest: vi.fn(),
  invalidateQueries: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: any) => {
    const root = queryKey?.[0];
    if (root === "/api/auth/me") return { data: { role: "Developer" } };
    if (root === "/api/locations") {
      return {
        data: [
          { id: 11, name: "Main" },
          { id: 12, name: "Warehouse" },
        ],
      };
    }
    if (root === "/api/stock-items/light") {
      return {
        data: [
          { id: 7, name: "Bolt", code: "BLT" },
          { id: 8, name: "Nut", code: "NUT" },
        ],
      };
    }
    if (root === "/api/inventory-by-location") {
      return {
        data: [
          { stockItemId: 7, stockItemName: "Bolt", stockItemCode: "BLT", quantity: "8" },
          { stockItemId: 8, stockItemName: "Nut", stockItemCode: "NUT", quantity: "20" },
        ],
        isLoading: false,
      };
    }
    return { data: [], isLoading: false };
  },
  useMutation: (config: any) => ({
    isPending: false,
    mutate: vi.fn(async (value?: any) => {
      try {
        const result = await config.mutationFn(value);
        config.onSuccess?.(result, value);
        config.onSettled?.();
        return result;
      } catch (error) {
        config.onError?.(error);
        config.onSettled?.();
        throw error;
      }
    }),
  }),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: harness.toast }) }));
vi.mock("@/contexts/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { id: 4, name: "GC Lshi" } }),
}));
vi.mock("@/contexts/AppModeContext", () => ({ useAppMode: () => "erp" }));
vi.mock("@/contexts/ApplicationLanguageContext", () => ({
  useApplicationLanguage: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/factoryApi", () => ({ getApiRequest: () => harness.modeApiRequest }));
vi.mock("@/lib/queryClient", () => ({
  apiRequest: harness.apiRequest,
  queryClient: { invalidateQueries: harness.invalidateQueries },
}));
vi.mock("@/lib/excelHelper", () => ({
  utils: {
    json_to_sheet: vi.fn(() => ({})),
    book_new: vi.fn(() => ({})),
    book_append_sheet: vi.fn(),
    sheet_to_json: vi.fn(() => []),
  },
  writeFile: vi.fn(),
  readFile: vi.fn(),
  read: vi.fn(),
}));
vi.mock("wouter", () => ({ Link: ({ children }: any) => <>{children}</> }));
vi.mock("@/pages/settings/BulkRenameTab", () => ({
  BulkRenameTab: () => <div data-testid="bulk-rename-dialog">Bulk rename open</div>,
}));
vi.mock("@/pages/settings/datatoolstab/components/ReconcileOTWNamesCard", () => ({
  ReconcileOTWNamesCard: () => <div>Reconcile OTW</div>,
}));
vi.mock("@/pages/settings/datatoolstab/components/MergeStockItemsLauncher", () => ({
  MergeStockItemsLauncher: () => <div>Merge stock items</div>,
}));

const SelectContext = createContext<((value: string) => void) | null>(null);
vi.mock("@/components/ui/select", () => ({
  Select: ({ children, onValueChange }: any) => (
    <SelectContext.Provider value={onValueChange}>{children}</SelectContext.Provider>
  ),
  SelectTrigger: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  SelectValue: ({ placeholder }: any) => <span>{placeholder}</span>,
  SelectContent: ({ children }: any) => <div>{children}</div>,
  SelectItem: ({ children, value }: any) => {
    const onValueChange = useContext(SelectContext);
    return (
      <button type="button" onClick={() => onValueChange?.(value)}>
        {children}
      </button>
    );
  },
}));

import { DataToolsTab } from "@/pages/settings/DataToolsTab";

describe("ERP data tools behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.apiRequest.mockImplementation(async (_method: string, url: string) => {
      if (url === "/api/sales-report/recalculate-costs") {
        return {
          ok: true,
          json: async () => ({ updatedCount: 4, totalChecked: 5 }),
        };
      }
      return {
        ok: true,
        json: async () => ({ applied: 1, updatedCount: 4, totalChecked: 5 }),
      };
    });
    harness.modeApiRequest.mockResolvedValue({
      ok: true,
      json: async () => ({ updated: 2 }),
    });
  });

  it("shows developer inventory tools and opens bulk rename state", () => {
    render(<DataToolsTab />);

    expect(screen.getByRole("heading", { name: "Data Tools" })).toBeInTheDocument();
    expect(screen.getByText("Silent Stock Transfer")).toBeInTheDocument();
    expect(screen.getByText("Silent Production / Consumption")).toBeInTheDocument();
    expect(screen.getByText("Merge stock items")).toBeInTheDocument();
    expect(screen.getByText("Reconcile OTW")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("button-open-bulk-rename"));
    expect(screen.getByTestId("bulk-rename-dialog")).toBeInTheDocument();
  });

  it("runs the sales cost repair mutation and invalidates the sales report", async () => {
    render(<DataToolsTab />);
    fireEvent.click(screen.getByTestId("button-fix-cost-prices"));

    await waitFor(() =>
      expect(harness.apiRequest).toHaveBeenCalledWith("POST", "/api/sales-report/recalculate-costs", {})
    );
    await waitFor(() => {
      expect(harness.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["/api/sales-report"] });
      expect(harness.toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Cost Prices Updated", description: "Updated 4 of 5 sales items" })
      );
    });
  });

  it("builds and applies a silent production adjustment from live location stock", async () => {
    render(<DataToolsTab />);
    fireEvent.click(screen.getByTestId("button-open-silent-production"));

    expect(screen.getByRole("heading", { name: "Silent Production / Consumption" })).toBeInTheDocument();
    const mainOptions = screen.getAllByRole("button", { name: "Main" });
    fireEvent.click(mainOptions.at(-1)!);

    fireEvent.change(screen.getByTestId("input-silent-prod-search"), { target: { value: "bolt" } });
    fireEvent.click(screen.getByTestId("button-silent-prod-search-item-7"));
    expect(screen.getByTestId("text-current-qty-1")).toHaveTextContent("8");

    fireEvent.change(screen.getByTestId("input-silent-prod-qty-1"), { target: { value: "3" } });
    expect(screen.getByTestId("text-new-qty-1")).toHaveTextContent("11");
    fireEvent.change(screen.getByTestId("input-silent-prod-rate-1"), { target: { value: "2.5" } });
    fireEvent.click(screen.getByTestId("button-silent-prod-apply"));

    await waitFor(() =>
      expect(harness.apiRequest).toHaveBeenCalledWith("POST", "/api/inventory/silent-production", {
        locationId: "11",
        type: "Production",
        items: [{ stockItemId: "7", quantity: "3", rate: "2.5" }],
      })
    );
    expect(screen.getByText("Applied 1 item(s) silently")).toBeInTheDocument();
  });

  it("switches silent adjustments to consumption and previews the reduced quantity", () => {
    render(<DataToolsTab />);
    fireEvent.click(screen.getByTestId("button-open-silent-production"));
    fireEvent.click(screen.getAllByRole("button", { name: "Main" }).at(-1)!);
    fireEvent.change(screen.getByTestId("input-silent-prod-search"), { target: { value: "NUT" } });
    fireEvent.click(screen.getByTestId("button-silent-prod-search-item-8"));
    fireEvent.click(screen.getByTestId("button-type-consumption"));
    fireEvent.change(screen.getByTestId("input-silent-prod-qty-1"), { target: { value: "4" } });

    expect(screen.getByTestId("text-current-qty-1")).toHaveTextContent("20");
    expect(screen.getByTestId("text-new-qty-1")).toHaveTextContent("16");
    expect(screen.queryByTestId("input-silent-prod-rate-1")).not.toBeInTheDocument();
  });
});
