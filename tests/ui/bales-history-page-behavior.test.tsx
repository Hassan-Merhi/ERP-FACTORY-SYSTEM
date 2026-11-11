import React from "react";

vi.mock("@/contexts/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { id: 1, name: "Test Factory", companyType: "factory" } }),
  useOptionalCompany: () => ({ selectedCompany: { id: 1, name: "Test Factory", companyType: "factory" } }),
}));
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  invalidateQueries: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: any) => {
    if (queryKey?.[0] === "/api/factory/my-access") {
      return { data: { companyId: 1, hasFactoryAccess: true, fullAccess: true, pageKeys: [], hiddenCostFields: [] } };
    }
    if (queryKey?.[0] === "/api/factory/bales" && queryKey.length > 2) {
      const today = new Date().toLocaleDateString("en-CA");
      return {
        data: {
          items: [
            {
              bale: {
                id: 1,
                referenceNumber: "REF-001",
                baleCode: "B-001",
                productName: "Shirts",
                articleCode: "SH-1",
                category: "Shirts",
                quantity: 2,
                weightKg: "50",
                status: "IN_STOCK",
                stockEntryDate: today,
                createdAt: `${today}T08:00:00.000Z`,
                lastPrintedAt: null,
                mixBatchId: 11,
              },
              product: { id: 7, name: "Shirts", articleCode: "SH-1", sellingPrice: "15" },
              mixBatch: { id: 11, name: "Batch A" },
            },
            {
              bale: {
                id: 2,
                referenceNumber: "REF-002",
                baleCode: "B-002",
                productName: "Shirts",
                articleCode: "SH-1",
                category: "Shirts",
                quantity: 1,
                weightKg: "25",
                status: "SOLD",
                stockEntryDate: today,
                createdAt: `${today}T09:00:00.000Z`,
                lastPrintedAt: null,
                mixBatchId: 11,
              },
              product: { id: 7, name: "Shirts", articleCode: "SH-1", sellingPrice: "15" },
              mixBatch: { id: 11, name: "Batch A" },
            },
          ],
          total: 2,
          page: 1,
          limit: 100,
          totalPages: 1,
        },
        isLoading: false,
      };
    }
    if (queryKey?.[0] === "/api/factory/mix-batches") return { data: [{ id: 11, name: "Batch A" }] };
    return { data: null, isLoading: false };
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

vi.mock("@/hooks/use-admin-override", () => ({
  useAdminOverride: () => ({
    wrapAdminAction: (action: () => void) => action(),
    AdminDialog: () => null,
  }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: harness.toast }) }));
vi.mock("@/contexts/AppModeContext", () => ({ useAppMode: () => "factory" }));
vi.mock("@/lib/factoryApi", () => ({ getApiRequest: () => harness.apiRequest }));
vi.mock("@/lib/queryClient", () => ({
  queryClient: { invalidateQueries: harness.invalidateQueries },
}));
vi.mock("@/lib/zebraPrint", () => ({ isZebraMode: () => false, printRawZpl: vi.fn() }));
vi.mock("@/lib/zplBuilder", () => ({ buildZplBatch: () => "^XA^XZ" }));
vi.mock("@/components/LabelPrintSettings", () => ({
  LabelPrintSettings: () => null,
  getPaperFormat: () => "A5",
}));
vi.mock("@/lib/labelHtml", () => ({
  generateCombinedLabelsHtml: () => "<html></html>",
  generateA5LabelsHtml: () => "<html></html>",
  generateStickerLabelsHtml: () => "<html></html>",
  prefetchBannersForPrint: vi.fn(),
  formatLabelNum: (value: unknown) => String(Number(value)),
}));
vi.mock("@/hooks/useLabelDesignColors", () => ({ useLabelDesignColors: () => ({ colors: [] }) }));
vi.mock("@/components/BaleWeightEditDialog", () => ({ BaleWeightEditDialog: () => null }));

import BalesHistory from "@/pages/factory/BalesHistory";

describe("factory bales history behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.apiRequest.mockResolvedValue({
      ok: true,
      json: async () => ({ removed: 1, imported: 1, totalWeight: "50" }),
    });
  });

  it("summarizes current stock and groups matching bale rows", () => {
    render(<BalesHistory />);

    expect(screen.getByRole("heading", { name: "Bales" })).toBeInTheDocument();
    expect(screen.getByTestId("badge-total-bales")).toHaveTextContent("3 bales");
    expect(screen.getByTestId("badge-total-weight")).toHaveTextContent("75 kg");
    expect(screen.getByText("Shirts")).toBeInTheDocument();
    expect(screen.getByText("2 bales")).toBeInTheDocument();
  });

  it("navigates dates through buttons and keyboard shortcuts", () => {
    render(<BalesHistory />);
    const dateInput = screen.getByTestId("input-date-filter") as HTMLInputElement;
    const original = dateInput.value;

    fireEvent.click(screen.getByTestId("button-prev-date"));
    expect(dateInput.value).not.toBe(original);
    fireEvent.click(screen.getByTestId("button-next-date"));
    expect(dateInput.value).toBe(original);

    fireEvent.keyDown(window, { key: "-" });
    expect(dateInput.value).not.toBe(original);
    fireEvent.keyDown(window, { key: "+" });
    expect(dateInput.value).toBe(original);
  });

  it("filters by search text and restores the group when cleared", () => {
    render(<BalesHistory />);
    const searchInput = screen.getByTestId("input-bales-search");

    fireEvent.change(searchInput, { target: { value: "missing" } });
    expect(screen.getByText("No bales found")).toBeInTheDocument();
    expect(screen.getByText("Try a different search term")).toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: "REF-001" } });
    expect(screen.getByText("Shirts")).toBeInTheDocument();
  });

  it("selects a grouped stock row and exposes stock-removal actions", async () => {
    render(<BalesHistory />);
    const groupCheckbox = screen.getByTestId(/checkbox-group-/);
    fireEvent.click(groupCheckbox);

    expect(screen.getByText("2 selected")).toBeInTheDocument();
    expect(screen.getByTestId("button-remove-bales")).toHaveTextContent("Remove (1)");

    fireEvent.click(screen.getByTestId("button-clear-selection"));
    await waitFor(() => expect(screen.queryByText("2 selected")).not.toBeInTheDocument());
  });
});
