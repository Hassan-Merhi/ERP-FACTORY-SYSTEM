import React, { createContext, useContext } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  toast: vi.fn(),
  invalidateQueries: vi.fn(),
  fetchQuery: vi.fn(),
}));

const bale = {
  id: 101,
  stockEntryDate: "2026-08-12",
  locationName: "Main",
  workerName: "Alice",
  productName: "Shirts",
  articleCode: "SH-1",
  referenceNumber: "REF-101",
  weightKg: "25",
  status: "IN_STOCK",
  finalizedAt: "2026-08-12T09:00:00.000Z",
};
const group = {
  stockEntryDate: "2026-08-12",
  erpLocationId: 11,
  locationName: "Main",
  workerId: 1,
  workerName: "Alice",
  productId: 7,
  productName: "Shirts",
  articleCode: "SH-1",
  baleCount: 3,
  totalWeight: "75",
  avgWeight: "25",
  firstFinalizedAt: "2026-08-12T08:00:00.000Z",
  lastFinalizedAt: "2026-08-12T10:00:00.000Z",
  bales: [bale],
};

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: harness.invalidateQueries,
    fetchQuery: harness.fetchQuery,
  }),
  useQueries: () => [],
  useQuery: ({ queryKey }: any) => {
    const root = queryKey?.[0];
    if (root === "/api/factory/bales/stock-entry-history") {
      return { data: { items: [group], total: 1, totalBales: 3, totalWeight: 75 }, isLoading: false };
    }
    if (root === "/api/factory/workers") {
      return {
        data: [
          { id: 1, fullName: "Alice", active: true },
          { id: 2, fullName: "Bob", active: true },
        ],
      };
    }
    if (root === "/api/factory/bale-products") return { data: [{ id: 7, name: "Shirts" }] };
    if (root === "/api/locations") return { data: [{ id: 11, name: "Main" }] };
    if (root === "/api/factory/worker-categories") return { data: [{ id: 4, name: "Pressing", workerIds: [1] }] };
    if (root === "/api/factory/categories") return { data: [{ id: 5, name: "Clothing" }] };
    if (root === "/api/factory/staff-tracking") {
      return {
        data: {
          page: "production",
          periodType: "daily",
          periodStart: "2026-08-12",
          periodEnd: "2026-08-12",
          finalized: false,
          rows: [
            {
              personType: "worker",
              personId: 1,
              name: "Alice",
              code: null,
              category: "Pressing",
              targetBales: 4,
              producedBales: 2,
              status: "Present",
              notes: "",
              active: true,
            },
          ],
        },
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

vi.mock("@/contexts/DateFormatContext", () => ({
  useDateFormat: () => ({ formatDisplayDate: (value: string) => `D:${value}` }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: harness.toast }) }));
vi.mock("@/lib/queryClient", () => ({ apiRequest: harness.apiRequest }));
vi.mock("@/lib/excelHelper", () => ({
  utils: {
    book_new: vi.fn(() => ({})),
    json_to_sheet: vi.fn(() => ({})),
    book_append_sheet: vi.fn(),
    aoa_to_sheet: vi.fn(() => ({})),
    sheet_add_aoa: vi.fn(),
  },
  writeFile: vi.fn(),
}));
vi.mock("@/pages/stockentryhistory/utils", () => ({
  STATUS_COLORS: { IN_STOCK: "ok" },
  STATUS_OPTIONS: ["IN_STOCK", "SOLD"],
  fetchAllStockEntryHistoryPages: vi.fn(async () => [group]),
  formatHistoryTime: vi.fn((value: string) => value),
  buildWorkerMatrix: vi.fn(() => ({
    workers: ["Alice"],
    rows: [{ productLabel: "Shirts (SH-1)", counts: { Alice: 3 }, total: 3 }],
    workerTotals: { Alice: 3 },
    grandTotal: 3,
  })),
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
    const onChange = useContext(SelectContext);
    return (
      <button type="button" onClick={() => onChange?.(value)}>
        {children}
      </button>
    );
  },
}));
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: any) => <div>{children}</div>,
  PopoverTrigger: ({ children }: any) => <>{children}</>,
  PopoverContent: ({ children }: any) => <div>{children}</div>,
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: any) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: any) => <>{children}</>,
  DropdownMenuContent: ({ children }: any) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick, ...props }: any) => (
    <button type="button" onClick={onClick} {...props}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => null,
}));

import StockEntryHistory from "@/pages/StockEntryHistory";

describe("stock entry history page behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.fetchQuery.mockResolvedValue([group]);
    harness.apiRequest.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
  });

  it("summarizes worker production against Production Targets", () => {
    render(<StockEntryHistory />);

    expect(screen.getByRole("heading", { name: "Stock Entry History" })).toBeInTheDocument();
    const workerCell = screen.getByRole("cell", { name: "Alice" });
    expect(workerCell).toBeInTheDocument();
    const workerRow = workerCell.closest("tr");
    expect(workerRow).not.toBeNull();
    expect(within(workerRow!).getByRole("cell", { name: "3" })).toBeInTheDocument();
    expect(within(workerRow!).getByRole("cell", { name: "75.00" })).toBeInTheDocument();
    expect(screen.getByText("-2")).toBeInTheDocument();
  });

  it("switches to detailed bale history and exposes the recorded reference", () => {
    render(<StockEntryHistory />);
    fireEvent.click(screen.getByTestId("button-view-detailed"));

    expect(screen.getByText("REF-101")).toBeInTheDocument();
    expect(screen.getByText("SH-1")).toBeInTheDocument();
    expect(screen.getAllByText("IN_STOCK")).not.toHaveLength(0);
  });

  it("reports the active date and deactivates it when the From toggle is cleared", async () => {
    const onActiveDateChange = vi.fn();
    render(<StockEntryHistory onActiveDateChange={onActiveDateChange} />);

    await waitFor(() => expect(onActiveDateChange).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)));
    fireEvent.click(screen.getByTestId("button-toggle-from-date"));
    await waitFor(() => expect(onActiveDateChange).toHaveBeenLastCalledWith(null));
  });

  it("sends the worker PDF to WhatsApp and surfaces success feedback", async () => {
    render(<StockEntryHistory />);
    fireEvent.click(screen.getByTestId("button-send-worker-pdf-whatsapp"));

    await waitFor(() =>
      expect(harness.apiRequest).toHaveBeenCalledWith("POST", "/api/factory/bales/send-worker-pdf-whatsapp", {
        date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      })
    );
    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Sent", description: "Worker PDF sent to production WhatsApp group." })
    );
  });
});
