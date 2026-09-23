import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  toast: vi.fn(),
  navigate: vi.fn(),
  apiRequest: vi.fn(),
  invalidateQueries: vi.fn(),
  refetchQueries: vi.fn(),
  getQueryData: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: any) => {
    const root = queryKey?.[0];
    if (root === "/api/stock-items/light") return { data: [{ id: 7, code: "A7", name: "Item 7" }] };
    if (root === "/api/locations")
      return {
        data: [
          { id: 2, name: "Source" },
          { id: 8, name: "Dest" },
        ],
      };
    if (root === "/api/my-locations") return { data: [{ id: 2, name: "Source" }] };
    if (root === "/api/vouchers" && queryKey?.[1] === 90)
      return { data: { id: 90, voucherDate: "2026-08-01", optional: false } };
    if (root === "/api/stock-transfers" && queryKey?.[1] === 90) {
      return {
        data: {
          id: 9,
          voucherId: 90,
          destinationLocationId: 8,
          notes: "original",
          items: [{ stockItemId: 7, sourceLocationId: 2, quantity: "5", rate: "10" }],
        },
      };
    }
    if (root === "/api/stock-transfers" && queryKey?.[1] === 9 && queryKey?.[2] === "revisions") {
      return {
        data: [
          {
            id: 41,
            revisionNumber: 1,
            optional: true,
            items: [
              {
                stockItemId: 7,
                stockItemName: "Item 7",
                sourceLocationName: "Source",
                originalQuantity: "5",
                delta: "1",
                newQuantity: "6",
              },
            ],
          },
        ],
      };
    }
    if (typeof root === "string" && root === "/api/locations/2/inventory")
      return {
        data: [{ stockItemId: 7, stockItemName: "Item 7", stockItemCode: "A7", averageRate: "10", quantity: "20" }],
      };
    return { data: [] };
  },
  useMutation: (config: any) => {
    const run = async (value: any) => {
      try {
        const result = await config.mutationFn(value);
        await config.onSuccess?.(result, value);
        return result;
      } catch (error) {
        config.onError?.(error, value);
        throw error;
      }
    };
    return { isPending: false, mutate: vi.fn((value: any) => void run(value)), mutateAsync: vi.fn(run) };
  },
}));
vi.mock("@/contexts/CompanyContext", () => ({ useCompany: () => ({ selectedCompany: { id: 4, name: "GC Lshi" } }) }));
vi.mock("@/contexts/CurrencyContext", () => ({
  useCurrencyContext: () => ({ formatAmount: (v: number) => `$${Number(v).toFixed(2)}` }),
}));
vi.mock("@/contexts/AppModeContext", () => ({ useAppMode: () => "erp", useModePrefix: () => "" }));
vi.mock("@/lib/factoryApi", () => ({ getApiRequest: () => harness.apiRequest }));
vi.mock("@/lib/queryClient", () => ({
  queryClient: {
    invalidateQueries: harness.invalidateQueries,
    refetchQueries: harness.refetchQueries,
    getQueryData: harness.getQueryData,
  },
}));
vi.mock("wouter", () => ({ useLocation: () => ["/vouchers", harness.navigate] }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: harness.toast }) }));
vi.mock("@hookform/resolvers/zod", () => ({ zodResolver: () => async (values: any) => ({ values, errors: {} }) }));
vi.mock("@/lib/excelHelper", () => ({
  utils: { json_to_sheet: vi.fn(), book_new: vi.fn(), book_append_sheet: vi.fn() },
  writeFile: vi.fn(),
}));
vi.mock("@/components/vouchers/PrintTemplate", () => ({
  parseDateLocal: (value: string) => new Date(`${value}T00:00:00`),
}));
vi.mock("@/lib/formatNumber", () => ({ formatNumber: (v: number) => String(v) }));
vi.mock("@/pages/vouchers/stock-transfer-form/useTransferFormDerived", () => ({
  usePendingTransferRevisions: (rows: any[]) => rows.filter((r) => r.optional),
  useFilteredTransferInventory: (rows: any[]) => rows,
  useTransferRateAutofill: vi.fn(),
}));
vi.mock("@/pages/vouchers/stock-transfer-form/dialogs/ApproveRevisionDialog", () => ({
  ApproveRevisionDialog: ({ approveRevisionTarget, approveRevisionMutation }: any) =>
    approveRevisionTarget ? (
      <button
        data-testid="confirm-approve-revision"
        onClick={() => approveRevisionMutation.mutate(approveRevisionTarget.id)}
      >
        Confirm approve
      </button>
    ) : null,
}));
vi.mock("@/pages/vouchers/stock-transfer-form/dialogs/SaveAsRevisionDialog", () => ({
  SaveAsRevisionDialog: ({
    transferRevisionDialogOpen,
    transferRevisionNote,
    setTransferRevisionNote,
    computeTransferRevisionItems,
    confirmTransferSaveAsRevision,
  }: any) =>
    transferRevisionDialogOpen ? (
      <div data-testid="revision-dialog">
        <div data-testid="revision-items">{JSON.stringify(computeTransferRevisionItems())}</div>
        <input
          data-testid="input-transfer-revision-note"
          value={transferRevisionNote}
          onChange={(e) => setTransferRevisionNote(e.target.value)}
        />
        <button data-testid="button-confirm-transfer-revision" onClick={confirmTransferSaveAsRevision}>
          Save Revision
        </button>
      </div>
    ) : null,
}));
vi.mock("@/pages/vouchers/stock-transfer-form/dialogs/ImportTransferExcelDialog", () => ({
  ImportTransferExcelDialog: () => null,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, variant: _v, size: _s, asChild: _a, ...props }: any) => <button {...props}>{children}</button>,
}));
vi.mock("@/components/ui/input", () => ({
  Input: React.forwardRef<HTMLInputElement, any>((props, ref) => <input ref={ref} {...props} />),
}));
vi.mock("@/components/ui/textarea", () => ({
  Textarea: React.forwardRef<HTMLTextAreaElement, any>((props, ref) => <textarea ref={ref} {...props} />),
}));
vi.mock("@/components/ui/card", () => ({ Card: ({ children }: any) => <div>{children}</div> }));
vi.mock("@/components/ui/badge", () => ({ Badge: ({ children }: any) => <span>{children}</span> }));
vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({ checked, onCheckedChange, ...props }: any) => (
    <input type="checkbox" checked={!!checked} onChange={(e) => onCheckedChange?.(e.target.checked)} {...props} />
  ),
}));
vi.mock("@/components/ui/switch", () => ({
  Switch: ({ checked, onCheckedChange, ...props }: any) => (
    <input type="checkbox" checked={!!checked} onChange={(e) => onCheckedChange?.(e.target.checked)} {...props} />
  ),
}));
vi.mock("@/components/ui/empty-state", () => ({ EmptyState: ({ title }: any) => <div>{title}</div> }));
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: any) => <div>{children}</div>,
  SelectContent: ({ children }: any) => <div>{children}</div>,
  SelectItem: ({ children }: any) => <div>{children}</div>,
  SelectTrigger: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  SelectValue: ({ placeholder }: any) => <span>{placeholder}</span>,
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: any) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: any) => <>{children}</>,
  DropdownMenuContent: ({ children }: any) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick, ...props }: any) => (
    <button onClick={onClick} {...props}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ children, open }: any) => (open ? <div>{children}</div> : null),
  AlertDialogAction: ({ children }: any) => <button>{children}</button>,
  AlertDialogCancel: ({ children }: any) => <button>{children}</button>,
  AlertDialogContent: ({ children }: any) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: any) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: any) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: any) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: any) => <div>{children}</div>,
}));
vi.mock("@/components/ui/form", async () => {
  const rhf = await import("react-hook-form");
  return {
    Form: ({ children }: any) => <>{children}</>,
    FormControl: ({ children }: any) => <>{children}</>,
    FormItem: ({ children }: any) => <div>{children}</div>,
    FormLabel: ({ children }: any) => <label>{children}</label>,
    FormField: ({ control, name, render }: any) => {
      const { field } = rhf.useController({ control, name });
      return render({ field });
    },
  };
});

import { StockTransferForm } from "@/pages/vouchers/StockTransferForm";

describe("stock transfer form revision behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.getQueryData.mockReturnValue([{ id: 41 }, { id: 42 }]);
    harness.refetchQueries.mockResolvedValue(undefined);
    harness.apiRequest.mockImplementation(async (_method: string, url: string) => ({
      ok: true,
      json: async () => (url.includes("/revisions") ? { id: 42 } : { id: 90 }),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => [] }))
    );
  });

  it("hydrates an existing transfer and applies +delta quantity editing relative to the persisted quantity", async () => {
    render(<StockTransferForm voucherIdToEdit={90} />);
    const qty = (await screen.findByTestId("input-transfer-quantity-0")) as HTMLInputElement;
    await waitFor(() => expect(qty.value).toBe("5"));
    expect(screen.getByTestId("text-transfer-total")).toHaveTextContent("$50.00");

    fireEvent.focus(qty);
    fireEvent.change(qty, { target: { value: "+2" } });
    fireEvent.blur(qty);
    await waitFor(() => expect(qty.value).toBe("7"));
    expect(screen.getByTestId("text-transfer-total")).toHaveTextContent("$70.00");
  });

  it("updates the transfer before recording the revision and then refetches both revision histories", async () => {
    render(<StockTransferForm voucherIdToEdit={90} />);
    const qty = (await screen.findByTestId("input-transfer-quantity-0")) as HTMLInputElement;
    await waitFor(() => expect(qty.value).toBe("5"));
    fireEvent.focus(qty);
    fireEvent.change(qty, { target: { value: "+2" } });
    fireEvent.blur(qty);

    fireEvent.click(screen.getByTestId("button-save-transfer-revision"));
    await waitFor(() => expect(screen.getByTestId("revision-dialog")).toBeInTheDocument());
    expect(screen.getByTestId("revision-items")).toHaveTextContent('"originalQuantity":5');
    expect(screen.getByTestId("revision-items")).toHaveTextContent('"delta":2');
    expect(screen.getByTestId("revision-items")).toHaveTextContent('"newQuantity":7');
    fireEvent.change(screen.getByTestId("input-transfer-revision-note"), { target: { value: "POS recount" } });
    fireEvent.click(screen.getByTestId("button-confirm-transfer-revision"));

    await waitFor(() =>
      expect(harness.apiRequest).toHaveBeenCalledWith(
        "PATCH",
        "/api/vouchers/90",
        expect.objectContaining({ totalAmount: "70" })
      )
    );
    expect(harness.apiRequest).toHaveBeenCalledWith(
      "PUT",
      "/api/stock-transfers/9",
      expect.objectContaining({
        destinationLocationId: 8,
        items: [expect.objectContaining({ stockItemId: 7, sourceLocationId: 2, quantity: "7", rate: "10" })],
      })
    );
    expect(harness.apiRequest).toHaveBeenCalledWith("POST", "/api/stock-transfers/9/revisions", {
      note: "POS recount",
      items: [expect.objectContaining({ stockItemId: 7, originalQuantity: 5, delta: 2, newQuantity: 7 })],
    });
    expect(harness.refetchQueries).toHaveBeenCalledWith({ queryKey: ["/api/stock-transfers", 9, "revisions"] });
    expect(harness.refetchQueries).toHaveBeenCalledWith({ queryKey: ["/api/stock-transfers/9/revisions"] });
    expect(harness.refetchQueries).toHaveBeenCalledWith({ queryKey: ["/api/stock-transfers/by-voucher/90/revisions"] });
    expect(harness.toast).toHaveBeenCalledWith({
      title: "Revision Saved",
      description: "Rev 2 recorded and transfer updated",
    });
  });

  it("approves a pending revision through the registered approval endpoint and invalidates transfer state", async () => {
    render(<StockTransferForm voucherIdToEdit={90} />);
    const historyToggle = await screen.findByText("Revision History");
    fireEvent.click(historyToggle.closest("button")!);
    const approveButton = await screen.findByTestId("button-approve-revision-41");
    expect(approveButton).toHaveAttribute("type", "button");
    fireEvent.click(approveButton);
    fireEvent.click(await screen.findByTestId("confirm-approve-revision"));

    await waitFor(() =>
      expect(harness.apiRequest).toHaveBeenCalledWith("POST", "/api/stock-transfer-revisions/41/approve", {})
    );
    expect(harness.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["/api/stock-transfers", 9, "revisions"] });
    expect(harness.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["/api/stock-transfers", 90] });
    expect(harness.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["/api/stock-transfers/list"] });
    expect(harness.apiRequest).not.toHaveBeenCalledWith(
      "PUT",
      "/api/stock-transfers/9",
      expect.anything()
    );
  });
});
