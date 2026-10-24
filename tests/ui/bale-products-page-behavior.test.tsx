import React, { createContext, useContext } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  currentRole: "Admin",
  apiRequest: vi.fn(),
  toast: vi.fn(),
  invalidateQueries: vi.fn(),
}));

const products = [
  {
    id: 1,
    articleCode: "HMD01000",
    code: "HMD01000",
    name: "Adult Shirts",
    nameAr: "قمصان",
    categoryId: 10,
    weightPerBaleKg: "45",
    productionPrice: "100",
    sellingPrice: "125",
    labelDesignColor: "blue",
    description: "shirts",
    active: true,
  },
  {
    id: 2,
    articleCode: "HMD02000",
    code: "HMD02000",
    name: "Baby Blankets",
    nameAr: "بطانيات",
    categoryId: 20,
    weightPerBaleKg: "50",
    productionPrice: "80",
    sellingPrice: "0",
    labelDesignColor: null,
    description: "blankets",
    active: true,
  },
  {
    id: 3,
    articleCode: "HMD03000",
    code: "HMD03000",
    name: "Hidden Pants",
    nameAr: "",
    categoryId: 10,
    weightPerBaleKg: "45",
    productionPrice: "70",
    sellingPrice: "95",
    labelDesignColor: null,
    description: "pants",
    active: false,
  },
];

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: any) => {
    const root = queryKey?.[0];
    if (root === "/api/auth/me") return { data: { id: "user-1", role: harness.currentRole, currentRole: harness.currentRole } };
    if (root === "/api/factory/my-access") return { data: { hiddenCostFields: [] } };
    if (root === "/api/factory/settings") return { data: { hideAvgCost: false, hideSellingPrice: false } };
    if (root === "/api/factory/bale-products") return { data: products, isLoading: false };
    if (root === "/api/factory/categories") {
      return {
        data: [
          { id: 10, name: "Clothing", isActive: true },
          { id: 20, name: "Home", isActive: true },
        ],
      };
    }
    return { data: [] };
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
        throw error;
      }
    }),
  }),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: harness.toast }) }));
vi.mock("@/contexts/AppModeContext", () => ({ useAppMode: () => "factory" }));
vi.mock("@/lib/factoryApi", () => ({ getApiRequest: () => harness.apiRequest }));
vi.mock("@/lib/queryClient", () => ({ queryClient: { invalidateQueries: harness.invalidateQueries } }));
vi.mock("@/hooks/useLabelDesignColors", () => ({
  useLabelDesignColors: () => ({ colors: [{ value: "blue", label: "Blue", color: "#0000ff" }] }),
}));
vi.mock("@shared/factoryProductSearch", () => ({
  productMatchesSearch: (product: any, query: string) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [product.name, product.articleCode, product.code]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(q));
  },
}));
vi.mock("@/pages/baleproducts/utils", () => ({ hmdLogoPath: "/logo.png" }));
vi.mock("@/pages/baleproducts/components/EmptyState", () => ({
  EmptyState: ({ onCreateClick }: any) => <button onClick={onCreateClick}>Create first product</button>,
}));
vi.mock("@/components/CreateBaleProductDialog", () => ({
  CreateBaleProductDialog: ({ open }: any) =>
    open ? <div data-testid="create-product-dialog">Create product dialog</div> : null,
}));
vi.mock("@/components/AdminAuthDialog", () => ({
  AdminAuthDialog: ({ open }: any) => (open ? <div data-testid="admin-auth-dialog">Admin auth</div> : null),
}));
vi.mock("@/components/ConfirmationDialog", () => ({ DeleteConfirmDialog: () => null }));

const SelectContext = createContext<((value: string) => void) | null>(null);
vi.mock("@/components/ui/select", () => ({
  Select: ({ children, onValueChange }: any) => (
    <SelectContext.Provider value={onValueChange}>{children}</SelectContext.Provider>
  ),
  SelectTrigger: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  SelectValue: ({ placeholder }: any) => <span>{placeholder ?? "selected"}</span>,
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
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: any) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: any) => <>{children}</>,
  DropdownMenuContent: ({ children }: any) => <div>{children}</div>,
  DropdownMenuItem: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  DropdownMenuLabel: ({ children }: any) => <span>{children}</span>,
  DropdownMenuSeparator: () => <hr />,
}));
vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({ checked, onCheckedChange, ...props }: any) => (
    <input type="checkbox" checked={Boolean(checked)} onChange={() => onCheckedChange?.(!checked)} {...props} />
  ),
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: any) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
}));

import BaleProducts from "@/pages/BaleProducts";

describe("bale products page behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.currentRole = "Admin";
    harness.apiRequest.mockImplementation(async (method: string, path: string, body?: unknown) => ({
      ok: true,
      json: async () => {
        if (method === "POST" && path.includes("cascade-update")) return { product: body, balesUpdated: 4 };
        return {};
      },
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) }))
    );
  });

  it("allows Owners to hide and restore items in Product List", async () => {
    harness.currentRole = "Owner";
    render(<BaleProducts />);
    fireEvent.click(screen.getByTestId("checkbox-product-1"));
    fireEvent.click(screen.getByTestId("button-bulk-hide"));
    await waitFor(() =>
      expect(harness.apiRequest).toHaveBeenCalledWith("POST", "/api/factory/bale-products/bulk-toggle-active", {
        ids: [1],
        active: false,
      })
    );
    fireEvent.click(screen.getByTestId("menu-filter-hidden"));
    fireEvent.click(screen.getByTestId("button-unhide-product-3"));
    await waitFor(() =>
      expect(harness.apiRequest).toHaveBeenCalledWith("POST", "/api/factory/bale-products/bulk-toggle-active", {
        ids: [3],
        active: true,
      })
    );
  });

  it("shows active products, hides inactive products, and filters by name or code", () => {
    render(<BaleProducts />);

    expect(screen.getByRole("heading", { name: "Bale Products" })).toBeInTheDocument();
    expect(screen.getByTestId("row-product-1")).toHaveTextContent("Adult Shirts");
    expect(screen.getByTestId("row-product-2")).toHaveTextContent("Baby Blankets");
    expect(screen.queryByTestId("row-product-3")).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId("input-search-products"), { target: { value: "HMD02000" } });
    expect(screen.queryByTestId("row-product-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("row-product-2")).toHaveTextContent("Baby Blankets");

    fireEvent.click(screen.getByTestId("button-clear-search"));
    expect(screen.getByTestId("row-product-1")).toBeInTheDocument();
  });

  it("bulk hides selected active products and refreshes the product query", async () => {
    render(<BaleProducts />);
    fireEvent.click(screen.getByTestId("checkbox-product-1"));
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("button-bulk-hide"));

    await waitFor(() =>
      expect(harness.apiRequest).toHaveBeenCalledWith("POST", "/api/factory/bale-products/bulk-toggle-active", {
        ids: [1],
        active: false,
      })
    );
    expect(harness.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["/api/factory/bale-products"] });
    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Products hidden", description: "1 product(s) updated." })
    );
  });

  it("manages categories and shows their product membership", async () => {
    render(<BaleProducts />);
    fireEvent.click(screen.getByTestId("menu-manage-categories"));

    expect(screen.getByText("Product Categories")).toBeInTheDocument();
    expect(screen.getByTestId("text-category-10")).toHaveTextContent("Clothing");
    fireEvent.click(screen.getByTestId("button-expand-category-10"));
    expect(screen.getByTestId("row-cat-product-1")).toHaveTextContent("Adult Shirts");
    expect(screen.getByTestId("row-cat-product-3")).toHaveTextContent("Hidden Pants");

    fireEvent.change(screen.getByTestId("input-new-category"), { target: { value: "Accessories" } });
    fireEvent.click(screen.getByTestId("button-add-category"));
    await waitFor(() =>
      expect(harness.apiRequest).toHaveBeenCalledWith("POST", "/api/factory/categories", { name: "Accessories" })
    );
    expect(harness.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Category created" }));
  });

  it("opens product creation and cascade-edits an existing product", async () => {
    render(<BaleProducts />);
    fireEvent.click(screen.getByTestId("button-create-product"));
    expect(screen.getByTestId("create-product-dialog")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("button-edit-product-1"));
    expect(screen.getByRole("heading", { name: "Edit Product" })).toBeInTheDocument();
    expect(screen.getByTestId("input-edit-product-name")).toHaveValue("Adult Shirts");
    fireEvent.change(screen.getByTestId("input-edit-product-name"), { target: { value: "Adult Shirts Premium" } });
    fireEvent.click(screen.getByTestId("button-label-color-none"));
    fireEvent.click(screen.getByTestId("button-save-edit-product"));

    await waitFor(() =>
      expect(harness.apiRequest).toHaveBeenCalledWith(
        "POST",
        "/api/factory/bale-products/1/cascade-update",
        expect.objectContaining({
          name: "Adult Shirts Premium",
          labelDesignColor: null,
        })
      )
    );
    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Product updated", description: "4 bale(s) also updated" })
    );
  });

  it("saves a cost price without resending null color, unchanged weight, category or grade", async () => {
    render(<BaleProducts />);
    fireEvent.click(screen.getByTestId("button-edit-product-2"));
    expect(screen.getByTestId("input-edit-product-production-price")).toHaveValue(80);

    fireEvent.change(screen.getByTestId("input-edit-product-production-price"), {
      target: { value: "94.35" },
    });
    fireEvent.click(screen.getByTestId("button-save-edit-product"));

    await waitFor(() =>
      expect(harness.apiRequest).toHaveBeenCalledWith(
        "POST",
        "/api/factory/bale-products/2/cascade-update",
        { productionPrice: "94.35" }
      )
    );
    expect(harness.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Product updated" }));
  });

  it("clears an existing cost price to zero without changing unrelated product fields", async () => {
    render(<BaleProducts />);
    fireEvent.click(screen.getByTestId("button-edit-product-1"));
    fireEvent.change(screen.getByTestId("input-edit-product-production-price"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByTestId("button-save-edit-product"));

    await waitFor(() =>
      expect(harness.apiRequest).toHaveBeenCalledWith(
        "POST",
        "/api/factory/bale-products/1/cascade-update",
        { productionPrice: "0" }
      )
    );
  });

  it("shows and restores hidden products from the hidden-products filter", async () => {
    render(<BaleProducts />);
    fireEvent.click(screen.getByTestId("menu-filter-hidden"));
    expect(screen.getByTestId("row-hidden-product-3")).toHaveTextContent("Hidden Pants");
    fireEvent.click(screen.getByTestId("button-unhide-product-3"));

    await waitFor(() =>
      expect(harness.apiRequest).toHaveBeenCalledWith("POST", "/api/factory/bale-products/bulk-toggle-active", {
        ids: [3],
        active: true,
      })
    );
    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Products unhidden", description: "1 product(s) updated." })
    );
  });
});
