import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  toast: vi.fn(),
  navigate: vi.fn(),
  apiRequest: vi.fn(),
  invalidateQueries: vi.fn(),
  setQueryData: vi.fn(),
}));

const orderDetail = {
  id: 77,
  customerId: 1,
  locationId: 11,
  proformaIdUsed: 5,
  containerNotes: "fragile",
  status: "LOADING",
  bales: [{ id: 10, baleReference: "REF-1", baleName: "Shirts", articleCode: "A1", weight: "50" }],
};

const capacitySnapshot = {
  proformaId: 5,
  companyId: 1,
  customerId: 1,
  proformaName: "PF-5",
  proformaActive: true,
  currentOrderId: 77,
  requestedTotalQty: 2,
  currentOrderLoadedTotalQty: 1,
  siblingLoadedTotalQty: 0,
  totalConsumedQty: 1,
  remainingTotalQty: 1,
  excessTotalQty: 0,
  articles: [
    {
      articleCode: "A1",
      normalizedArticleCode: "a1",
      isOnProforma: true,
      requestedQty: 2,
      currentOrderLoadedQty: 1,
      siblingLoadedQty: 0,
      totalConsumedQty: 1,
      remainingQty: 1,
      excessQty: 0,
      isFulfilled: false,
      isOverloaded: false,
      productName: "Shirts",
    },
  ],
};

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey, enabled }: any) => {
    const root = queryKey?.[0];
    if (root === "/api/factory/customers") return { data: [{ id: 1, legalName: "Buyer One" }] };
    if (root === "/api/locations") return { data: [{ id: 11, name: "Dock" }] };
    if (root === "/api/factory/customer-proformas/capacity") {
      // Phase 4 reads loading progress from the authoritative capacity snapshot
      // rather than recomputing it from the proforma lines. Without this branch
      // the prefix match below hands the page the proforma *list*, and it reads
      // an array as a snapshot.
      return { data: capacitySnapshot, isLoading: false, isFetching: false };
    }
    if (typeof root === "string" && root.startsWith("/api/factory/customer-proformas")) {
      return {
        data: [
          {
            id: 5,
            name: "PF-5",
            isActive: true,
            lines: [{ id: 1, articleCode: "A1", productName: "Shirts", quantity: 2 }],
          },
        ],
      };
    }
    if (root === "/api/factory/customer-orders" && queryKey?.[1] === 77 && queryKey?.length === 2)
      return { data: orderDetail };
    if (root === "/api/factory/bale-stock-count") return { data: { A1: 5 } };
    if (root === "/api/factory/customer-orders" && queryKey?.[2] === "bale-removals") {
      return {
        data: enabled
          ? [
              {
                id: 201,
                orderId: 77,
                baleId: 10,
                referenceNumber: "REF-REMOVED",
                articleCode: "A1",
                productName: "Shirts",
                weightKg: "50",
                removedByUsername: "loader",
                removedAt: "2026-08-28T10:00:00.000Z",
              },
            ]
          : [],
      };
    }
    return { data: [] };
  },
  useMutation: (config: any) => ({
    isPending: false,
    mutate: vi.fn(async (value: any) => {
      try {
        const result = await config.mutationFn(value);
        config.onSuccess?.(result, value);
        return result;
      } catch (error) {
        config.onError?.(error, value);
        return undefined;
      }
    }),
  }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: harness.toast }) }));
vi.mock("wouter", () => ({
  useLocation: () => ["/factory/sales/loading?orderId=77", harness.navigate],
  useSearch: () => "?orderId=77",
}));
vi.mock("@/contexts/AppModeContext", () => ({ useAppMode: () => "factory" }));
vi.mock("@/lib/factoryApi", () => ({ getApiRequest: () => harness.apiRequest }));
vi.mock("@/lib/queryClient", () => ({
  queryClient: { invalidateQueries: harness.invalidateQueries, setQueryData: harness.setQueryData },
  keyStartsWith: () => () => true,
}));
vi.mock("@/lib/excelHelper", () => ({
  utils: {
    book_new: vi.fn(() => ({})),
    aoa_to_sheet: vi.fn(() => ({})),
    book_append_sheet: vi.fn(),
    sheet_to_json: vi.fn(() => []),
  },
  writeFile: vi.fn(),
  read: vi.fn(),
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, size: _s, variant: _v, ...props }: any) => <button {...props}>{children}</button>,
}));
vi.mock("@/components/ui/input", () => ({
  Input: React.forwardRef<HTMLInputElement, any>((props, ref) => <input ref={ref} {...props} />),
}));
vi.mock("@/components/ui/textarea", () => ({ Textarea: (props: any) => <textarea {...props} /> }));
vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, ...props }: any) => <span {...props}>{children}</span>,
}));
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: any) => <div>{children}</div>,
  SelectContent: ({ children }: any) => <div>{children}</div>,
  SelectItem: ({ children }: any) => <div>{children}</div>,
  SelectTrigger: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  SelectValue: ({ placeholder }: any) => <span>{placeholder}</span>,
}));
vi.mock("@/components/ui/table", () => ({
  Table: ({ children }: any) => <table>{children}</table>,
  TableBody: ({ children }: any) => <tbody>{children}</tbody>,
  TableCell: ({ children, ...props }: any) => <td {...props}>{children}</td>,
  TableHead: ({ children, ...props }: any) => <th {...props}>{children}</th>,
  TableHeader: ({ children, ...props }: any) => <thead {...props}>{children}</thead>,
  TableRow: ({ children, ...props }: any) => <tr {...props}>{children}</tr>,
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: any) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <div>{children}</div>,
}));
vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ children, open }: any) => (open ? <div>{children}</div> : null),
  AlertDialogAction: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
  AlertDialogCancel: ({ children }: any) => <button>{children}</button>,
  AlertDialogContent: ({ children }: any) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: any) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: any) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: any) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: any) => <div>{children}</div>,
}));

class FakeAudioContext {
  currentTime = 0;
  destination = {};
  createOscillator() {
    return {
      frequency: { value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
      type: "sine",
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}

import FactoryContainerLoadingScan from "@/pages/factory/FactoryContainerLoadingScan";

describe("factory container loading scan behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    Object.defineProperty(window, "AudioContext", { configurable: true, value: FakeAudioContext });
    harness.apiRequest.mockImplementation(async (method: string, url: string, body: any) => {
      if (method === "POST" && url === "/api/factory/customer-orders/77/bales") {
        return {
          json: async () => ({
            ...orderDetail,
            bales: [
              ...orderDetail.bales,
              { id: 11, baleReference: body.scanCode, baleName: "Shirts", articleCode: "A1", weight: "48" },
            ],
          }),
        };
      }
      return { json: async () => ({ success: true }) };
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => [], text: async () => "" }))
    );
  });

  it("resumes an in-progress loading without restoring persisted scan evidence", async () => {
    render(<FactoryContainerLoadingScan />);
    await waitFor(() => expect(screen.getByTestId("badge-resuming")).toHaveTextContent("Resuming Loading #77"));
    expect(screen.getByTestId("badge-bale-count")).toHaveTextContent("1 bales");
    expect(screen.getByTestId("badge-total-weight")).toHaveTextContent("50.00 kg");
    expect(screen.queryByTestId("banner-last-scanned")).not.toBeInTheDocument();
    expect(screen.getByTestId("card-proforma-progress")).toBeInTheDocument();
    expect(screen.getByTestId("row-progress-A1")).toHaveTextContent("2");
    expect(screen.getByTestId("row-progress-A1")).toHaveTextContent("1");
    expect(screen.getByTestId("text-stock-A1")).toHaveTextContent("5");
  });

  it("scans a bale with the exact location payload without browser persistence", async () => {
    render(<FactoryContainerLoadingScan />);
    const input = await screen.findByTestId("input-scan-code");
    fireEvent.change(input, { target: { value: " REF-2 " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(harness.apiRequest).toHaveBeenCalledWith("POST", "/api/factory/customer-orders/77/bales", {
        scanCode: "REF-2",
        locationId: 11,
        allowBypassProforma: undefined,
        allowBypassOverload: undefined,
      })
    );
    expect(harness.setQueryData).toHaveBeenCalledWith(
      ["/api/factory/customer-orders", 77],
      expect.objectContaining({ bales: expect.arrayContaining([expect.objectContaining({ baleReference: "REF-2" })]) })
    );
    expect(localStorage.getItem("lastScannedBale_77")).toBeNull();
  });

  it("passes the explicit proforma bypass flag when Ignore Proforma is enabled", async () => {
    render(<FactoryContainerLoadingScan />);
    fireEvent.click(await screen.findByTestId("button-ignore-proforma"));
    expect(screen.getByTestId("button-ignore-proforma")).toHaveTextContent("Ignore: ON");
    expect(screen.getByTestId("button-ignore-proforma")).toHaveAttribute("aria-pressed", "true");
    const input = screen.getByTestId("input-scan-code");
    fireEvent.change(input, { target: { value: "EXTRA-1" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(harness.apiRequest).toHaveBeenCalledWith("POST", "/api/factory/customer-orders/77/bales", {
        scanCode: "EXTRA-1",
        locationId: 11,
        allowBypassProforma: true,
        allowBypassOverload: undefined,
      })
    );
  });

  it("persists a loading note and navigates from the proforma stock count to the exact bale list", async () => {
    render(<FactoryContainerLoadingScan />);
    const note = await screen.findByTestId("input-loading-note");
    fireEvent.change(note, { target: { value: "handle carefully" } });
    fireEvent.click(screen.getByTestId("button-save-note"));
    await waitFor(() =>
      expect(harness.apiRequest).toHaveBeenCalledWith("PATCH", "/api/factory/customer-orders/77/loading-note", {
        note: "handle carefully",
      })
    );
    expect(harness.toast).toHaveBeenCalledWith({ title: "Note saved" });

    fireEvent.click(screen.getByTestId("button-stock-detail-A1"));
    expect(harness.navigate).toHaveBeenCalledWith(expect.stringContaining("/factory/stock-bale-list?"));
    expect(harness.navigate.mock.calls.at(-1)?.[0]).toContain("articleCode=A1");
    expect(harness.navigate.mock.calls.at(-1)?.[0]).toContain("locationId=11");
  });

  it("shows the removed-bales section before it is expanded", async () => {
    render(<FactoryContainerLoadingScan />);

    await waitFor(() => {
      expect(screen.getByTestId("button-toggle-removal-log")).toBeInTheDocument();
    });
    expect(screen.getByTestId("badge-removal-count")).toHaveTextContent("1");
    expect(screen.queryByTestId("row-removal-201")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("button-toggle-removal-log"));
    expect(screen.getByTestId("row-removal-201")).toHaveTextContent("REF-REMOVED");
    expect(screen.getByTestId("row-removal-201")).toHaveTextContent("loader");
  });
});
