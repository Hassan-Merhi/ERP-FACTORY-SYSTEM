import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  navigate: vi.fn(),
  toast: vi.fn(),
  modeApiRequest: vi.fn(),
  invalidateQueries: vi.fn(),
}));

const inventory = [
  {
    productId: 7,
    productName: "Shirts",
    articleCode: "SH-1",
    categoryId: 10,
    category: "Tops",
    baleCount: 10,
    loadingCount: 2,
    totalWeight: 450,
    totalCost: 80,
    productionPrice: 8,
    sellingPrice: "12",
  },
  {
    productId: 8,
    productName: "Pants",
    articleCode: "PT-1",
    categoryId: 20,
    category: "Bottoms",
    baleCount: 4,
    loadingCount: 0,
    totalWeight: 200,
    totalCost: 36,
    productionPrice: 9,
    sellingPrice: "15",
  },
];

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: any) => {
    const root = queryKey?.[0];
    if (root === "/api/locations") {
      return {
        data: [
          { id: 11, name: "Main" },
          { id: 12, name: "Warehouse" },
        ],
        isLoading: false,
      };
    }
    if (root === "/api/factory/my-access") return { data: { fullAccess: true, hiddenCostFields: [] } };
    if (root === "/api/factory/settings") return { data: { hideSellingPrice: false, hideAvgCost: false } };
    if (root === "/api/factory/location-inventory/11") return { data: inventory, isLoading: false };
    if (root === "/api/factory/location-inventory/11/available") return { data: inventory, isLoading: false };
    if (root === "/api/factory/bale-products") {
      return {
        data: inventory.map((p) => ({
          id: p.productId,
          articleCode: p.articleCode,
          name: p.productName,
          sellingPrice: p.sellingPrice,
          productionPrice: String(p.productionPrice),
          categoryId: p.categoryId,
          active: true,
        })),
      };
    }
    if (root === "/api/factory/categories") {
      return {
        data: [
          { id: 10, name: "Tops" },
          { id: 20, name: "Bottoms" },
        ],
      };
    }
    if (root === "/api/factory/customers") return { data: [{ id: 1, legalName: "Customer A" }] };
    return { data: [], isLoading: false };
  },
  useMutation: (config: any) => ({
    isPending: false,
    mutate: vi.fn(async (value?: any) => {
      try {
        const result = await config.mutationFn(value);
        config.onSuccess?.(result, value);
        return result;
      } catch (error) {
        config.onError?.(error);
        return undefined;
      }
    }),
  }),
}));
vi.mock("wouter", () => ({ useLocation: () => ["/factory/location-inventory", harness.navigate] }));
vi.mock("@/contexts/CurrencyContext", () => ({
  useCurrencyContext: () => ({ formatAmount: (value: unknown) => `$${Number(value).toFixed(2)}` }),
}));
vi.mock("@/contexts/AppModeContext", () => ({ useAppMode: () => "factory" }));
vi.mock("@/lib/factoryApi", () => ({ getApiRequest: () => harness.modeApiRequest }));
vi.mock("@/lib/queryClient", () => ({
  apiRequest: vi.fn(),
  queryClient: { invalidateQueries: harness.invalidateQueries },
  keyStartsWith: () => () => true,
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: harness.toast }) }));
vi.mock("react-to-print", () => ({ useReactToPrint: () => vi.fn() }));
vi.mock("@/hooks/use-escape-back", () => ({ useEscapeBack: vi.fn() }));
vi.mock("@/lib/zebraPrint", () => ({ isZebraMode: () => false, printRawZpl: vi.fn() }));
vi.mock("@/lib/zplBuilder", () => ({ buildZplBatch: () => "^XA^XZ" }));
vi.mock("@/components/LabelPrintSettings", () => ({ getPaperFormat: () => "A5" }));
vi.mock("@/lib/labelHtml", () => ({
  generateCombinedLabelsHtml: () => "<html />",
  generateA5LabelsHtml: () => "<html />",
  generateStickerLabelsHtml: () => "<html />",
  prefetchBannersForPrint: vi.fn(),
}));
vi.mock("@/hooks/useLabelDesignColors", () => ({ useLabelDesignColors: () => ({ colors: [] }) }));
vi.mock("@shared/factoryProductSearch", () => ({
  productMatchesSearch: (product: any, query: string) => {
    const q = query.toLowerCase();
    return !q || product.name.toLowerCase().includes(q) || product.articleCode.toLowerCase().includes(q);
  },
}));
vi.mock("@/pages/factory/factorylocationinventory/utils", () => ({
  applySortProducts: (items: any[]) => [...items].sort((a, b) => a.productName.localeCompare(b.productName)),
  catColor: () => "",
  isSpecialFactoryCategory: () => false,
}));
vi.mock("@/pages/factory/factorylocationinventory/components/StatCard", () => ({
  StatCard: ({ label, value, sub }: any) => (
    <div data-testid={`stat-${label.replace(/\s+/g, "-").toLowerCase()}`}>
      {label}:{value}:{sub ?? ""}
    </div>
  ),
}));
vi.mock("@/pages/factory/factory-location-inventory/dialogs/FinalizeProformaDialog", () => ({
  FinalizeProformaDialog: () => null,
}));
vi.mock("@/pages/factory/factory-location-inventory/dialogs/RenameLocationDialog", () => ({
  RenameLocationDialog: () => null,
}));
vi.mock("@/pages/factory/factory-location-inventory/dialogs/StockOverloadWarningDialog", () => ({
  StockOverloadWarningDialog: () => null,
}));
vi.mock("@/pages/factory/factory-location-inventory/dialogs/RemoveBalesDialog", () => ({
  RemoveBalesDialog: () => null,
}));
vi.mock("@/pages/factory/factory-location-inventory/dialogs/PrintBarcodesDialog", () => ({
  PrintBarcodesDialog: () => null,
}));
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: any) => <div>{children}</div>,
  PopoverTrigger: ({ children }: any) => <>{children}</>,
  PopoverContent: ({ children }: any) => <div>{children}</div>,
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: any) => <div>{children}</div>,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
}));

import FactoryLocationInventory from "@/pages/factory/FactoryLocationInventory";

describe("factory location inventory page behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.modeApiRequest.mockResolvedValue({ ok: true, json: async () => ({ id: 1 }) });
    localStorage.clear();
  });

  it("filters the location chooser before opening a location", () => {
    render(<FactoryLocationInventory />);
    expect(screen.getByRole("heading", { name: "Location Inventory" })).toBeInTheDocument();
    expect(screen.getByTestId("row-location-11")).toHaveTextContent("Main");
    expect(screen.getByTestId("row-location-12")).toHaveTextContent("Warehouse");

    fireEvent.change(screen.getByTestId("input-search-locations"), { target: { value: "ware" } });
    expect(screen.queryByTestId("row-location-11")).not.toBeInTheDocument();
    expect(screen.getByTestId("row-location-12")).toBeInTheDocument();
  });

  it("computes physical stock KPIs after selecting a location", () => {
    render(<FactoryLocationInventory />);
    fireEvent.click(screen.getByTestId("row-location-11"));

    expect(screen.getByTestId("text-page-title")).toHaveTextContent("Main");
    // Bales and KG are combined cards (d64cb5a): the total, then regular and
    // wipers & garbage. Nothing here is a special category, so all of it is regular.
    // The card labels repeat as table headers, so anchor on the card-only split label.
    const balesCard = screen.getByText("Regular Bales").closest(".rounded-xl");
    expect(balesCard).toHaveTextContent(/Total Bales\s*12/);
    expect(balesCard).toHaveTextContent(/Regular Bales\s*12/);
    expect(balesCard).toHaveTextContent(/Wipers & Garbage Bales\s*0/);
    const kgCard = screen.getByText("Regular KG").closest(".rounded-xl");
    expect(kgCard).toHaveTextContent(/Total KG\s*650/);
    expect(kgCard).toHaveTextContent(/Regular KG\s*650/);
    expect(screen.getByTestId("stat-categories")).toHaveTextContent("2");
    expect(screen.getByTestId("stat-cost-value")).toHaveTextContent("$100.00");
    expect(screen.getByTestId("stat-sell-value")).toHaveTextContent("$156.00");
    expect(screen.getByTestId("row-product-7")).toHaveTextContent("Shirts");
    expect(screen.getByTestId("row-product-8")).toHaveTextContent("Pants");
  });

  it("opens product history in the selected location", () => {
    render(<FactoryLocationInventory />);
    fireEvent.click(screen.getByTestId("row-location-11"));
    fireEvent.click(screen.getByTestId("button-view-details-7"));
    expect(harness.navigate).toHaveBeenCalledWith("/factory/bale-product-history/7/11");
  });

  it("selects visible inventory into proforma mode and allows quantity/price editing", () => {
    render(<FactoryLocationInventory />);
    fireEvent.click(screen.getByTestId("row-location-11"));
    fireEvent.click(screen.getByTestId("button-toggle-proforma-mode"));

    expect(screen.getByTestId("note-proforma-advisory")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("button-select-all"));
    expect(screen.getByText(/2 items, 14 bales/)).toBeInTheDocument();
    expect(screen.getByTestId("input-qty-7")).toHaveValue(10);
    expect(screen.getByTestId("input-price-7")).toHaveValue(12);

    fireEvent.change(screen.getByTestId("input-qty-7"), { target: { value: "3" } });
    fireEvent.change(screen.getByTestId("input-price-7"), { target: { value: "20" } });
    expect(screen.getByTestId("input-qty-7")).toHaveValue(3);
    expect(screen.getByTestId("input-price-7")).toHaveValue(20);
    expect(screen.getByText(/2 items, 7 bales/)).toBeInTheDocument();
  });
});
