import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  toast: vi.fn(),
  apiRequest: vi.fn(),
  invalidateQueries: vi.fn(),
  navigate: vi.fn(),
}));

const priceItems = [
  {
    stockItemId: 101,
    code: "A101",
    name: "Blue Shirt",
    stockGroupName: "Clothes",
    sellingPrice: "20",
    baseSellingPrice: "18",
    hasCustomPrice: true,
    quantity: "5",
    costPrice: "10",
    offloadingCost: "2",
  },
  {
    stockItemId: 102,
    code: "A102",
    name: "Red Shirt",
    stockGroupName: "Clothes",
    sellingPrice: null,
    baseSellingPrice: null,
    hasCustomPrice: false,
    quantity: "3",
    costPrice: "8",
    offloadingCost: "1",
  },
];
const mastersData = {
  masters: [
    { id: 11, name: "Main" },
    { id: 12, name: "Branch" },
  ],
  items: [
    {
      stockItemId: 101,
      code: "A101",
      name: "Blue Shirt",
      stockGroupName: "Clothes",
      baseSellingPrice: null,
      masterPrices: { 11: "20", 12: "22" },
      totalQuantity: "8",
      costPrice: "10",
      offloadingCost: "2",
    },
    {
      stockItemId: 102,
      code: "A102",
      name: "Red Shirt",
      stockGroupName: "Clothes",
      baseSellingPrice: null,
      masterPrices: { 11: null, 12: null },
      totalQuantity: "3",
      costPrice: "8",
      offloadingCost: "1",
    },
  ],
};

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: any) => {
    const root = queryKey?.[0];
    if (root === "/api/auth/me") return { data: { role: "Admin" } };
    if (root === "/api/my-locations") {
      return { data: [{ id: 11, name: "Main" }], isLoading: false };
    }
    if (root === "/api/locations") {
      return {
        data: [
          { id: 11, name: "Main" },
          { id: 12, name: "Branch" },
        ],
        isLoading: false,
      };
    }
    if (root === "/api/pos/price-list") {
      return { data: priceItems, isLoading: false, isError: false, error: null };
    }
    if (root === "/api/pos/price-list-by-masters") {
      return { data: mastersData, isLoading: false, isError: false, error: null };
    }
    return { data: [], isLoading: false, isError: false, error: null };
  },
  useMutation: (config: any) => ({
    isPending: false,
    mutate: vi.fn(async (value: any) => {
      try {
        const result = await config.mutationFn(value);
        config.onSuccess?.(result);
        return result;
      } catch (error) {
        config.onError?.(error);
        throw error;
      }
    }),
  }),
}));
vi.mock("@/lib/queryClient", () => ({
  queryClient: { invalidateQueries: harness.invalidateQueries },
  apiRequest: harness.apiRequest,
}));
vi.mock("wouter", () => ({
  useLocation: () => ["/sales-tools?tab=pricelist", harness.navigate],
}));
vi.mock("@/pages/location-inventory/StockMovementDialog", () => ({
  StockMovementDialog: ({ stockMovementOpen, stockMovementItem }: any) =>
    stockMovementOpen ? (
      <div
        data-testid="price-stock-movement-dialog"
        data-location-id={stockMovementItem?.locationId ?? "all"}
        data-location-name={stockMovementItem?.locationName ?? "All Locations"}
      >
        {stockMovementItem?.stockItemName}
      </div>
    ) : null,
}));
vi.mock("@/contexts/CurrencyContext", () => ({
  useCurrencyContext: () => ({ formatAmount: (v: number) => `$${v.toFixed(2)}` }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: harness.toast }) }));
vi.mock("@/lib/utils", () => ({ cn: (...values: any[]) => values.filter(Boolean).join(" ") }));

vi.mock("@/components/ui/input", () => ({
  Input: React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>((props, ref) => (
    <input ref={ref} {...props} />
  )),
}));
vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: any) => <span>{children}</span>,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, variant: _v, size: _s, ...props }: any) => <button {...props}>{children}</button>,
}));
vi.mock("@/components/ui/table", () => ({
  Table: ({ children }: any) => <table>{children}</table>,
  TableBody: ({ children }: any) => <tbody>{children}</tbody>,
  TableCell: ({ children, ...props }: any) => <td {...props}>{children}</td>,
  TableHead: ({ children }: any) => <th>{children}</th>,
  TableHeader: ({ children }: any) => <thead>{children}</thead>,
  TableRow: ({ children, ...props }: any) => <tr {...props}>{children}</tr>,
}));
vi.mock("@/components/ui/skeleton", () => ({ Skeleton: () => <div>loading</div> }));
vi.mock("@/components/ui/alert", () => ({
  Alert: ({ children }: any) => <div>{children}</div>,
  AlertDescription: ({ children }: any) => <div>{children}</div>,
}));
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: any) => <div>{children}</div>,
  SelectContent: ({ children }: any) => <div>{children}</div>,
  SelectItem: ({ children }: any) => <div>{children}</div>,
  SelectTrigger: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  SelectValue: ({ placeholder }: any) => <span>{placeholder}</span>,
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: any) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <div>{children}</div>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
}));
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: any) => <div>{children}</div>,
}));

import POSPriceList from "@/pages/pos/POSPriceList";

describe("POS price list page behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.apiRequest.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
  });

  it("selects a location, filters items, surfaces unpriced stock, and updates a location price", async () => {
    render(<POSPriceList />);
    expect(screen.getByText("Select a location")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("button-location-11"));
    expect(screen.getByTestId("row-price-101")).toHaveTextContent("Blue Shirt");
    fireEvent.click(screen.getByTestId("link-price-history-101"));
    expect(screen.getByTestId("price-stock-movement-dialog")).toHaveTextContent("Blue Shirt");
    expect(screen.getByTestId("price-stock-movement-dialog")).toHaveAttribute("data-location-id", "11");
    expect(screen.getByTestId("price-stock-movement-dialog")).toHaveAttribute("data-location-name", "Main");
    expect(screen.getByTestId("row-price-102")).toHaveTextContent("Red Shirt");
    expect(screen.getByTestId("text-item-count")).toHaveTextContent("Showing 2 of 2 items");

    fireEvent.change(screen.getByTestId("input-price-search"), {
      target: { value: "Blue" },
    });
    expect(screen.getByTestId("row-price-101")).toBeInTheDocument();
    expect(screen.queryByTestId("row-price-102")).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId("input-price-search"), { target: { value: "" } });

    fireEvent.click(screen.getByTestId("button-show-unpriced"));
    expect(screen.getByTestId("row-price-102")).toBeInTheDocument();
    expect(screen.queryByTestId("row-price-101")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("button-show-unpriced"));

    fireEvent.click(screen.getByTestId("cell-price-101"));
    const input = screen.getByTestId("input-price-101");
    fireEvent.change(input, { target: { value: "25" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(harness.apiRequest).toHaveBeenCalledWith("POST", "/api/stock-items/101/location-prices", {
        locationId: 11,
        sellingPrice: "25",
      })
    );
    expect(harness.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["/api/pos/price-list", 11],
    });
    expect(harness.toast).toHaveBeenCalledWith({ title: "Price updated" });
  });

  it("supports all-locations visibility and independent master price editing", async () => {
    render(<POSPriceList />);
    fireEvent.click(screen.getByTestId("button-location-all"));

    expect(screen.getByTestId("chip-location-11")).toHaveTextContent("Main");
    expect(screen.getByTestId("chip-location-12")).toHaveTextContent("Branch");
    expect(screen.getByTestId("cell-price-101-11")).toHaveTextContent("$20.00");
    expect(screen.getByTestId("cell-price-101-12")).toHaveTextContent("$22.00");
    expect(screen.getByTestId("text-total-qty-101")).toHaveTextContent("8");
    fireEvent.click(screen.getByTestId("link-price-history-101"));
    expect(screen.getByTestId("price-stock-movement-dialog")).toHaveTextContent("Blue Shirt");
    expect(screen.getByTestId("price-stock-movement-dialog")).toHaveAttribute("data-location-id", "all");
    expect(screen.getByTestId("price-stock-movement-dialog")).toHaveAttribute("data-location-name", "All Locations");

    fireEvent.click(screen.getByTestId("chip-location-12"));
    expect(screen.queryByTestId("cell-price-101-12")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("button-show-all-locations"));
    expect(screen.getByTestId("cell-price-101-12")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("cell-price-101-12"));
    const input = screen.getByTestId("input-price-101-12");
    fireEvent.change(input, { target: { value: "24.5" } });
    fireEvent.click(screen.getByTestId("button-save-price-101-12"));
    await waitFor(() =>
      expect(harness.apiRequest).toHaveBeenCalledWith("POST", "/api/stock-items/101/location-prices", {
        locationId: 12,
        sellingPrice: "24.5",
      })
    );
    expect(harness.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["/api/pos/price-list-by-masters"],
    });
  });

  it("keeps POS users scoped to their assigned priced inventory and read-only", async () => {
    render(<POSPriceList posUser />);
    await waitFor(() => expect(screen.getByTestId("row-price-101")).toBeInTheDocument());
    expect(screen.queryByTestId("row-price-102")).not.toBeInTheDocument();
    expect(screen.queryByTestId("button-location-all")).not.toBeInTheDocument();
    expect(screen.queryByTestId("button-show-unpriced")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("cell-price-101"));
    expect(screen.queryByTestId("input-price-101")).not.toBeInTheDocument();
  });
});
