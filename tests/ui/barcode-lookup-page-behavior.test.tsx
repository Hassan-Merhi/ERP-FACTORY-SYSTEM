import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  modeApiRequest: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: any) => {
    if (queryKey?.[0] === "/api/auth/me") return { data: { role: "Admin" } };
    if (queryKey?.[0] === "/api/factory/bale-products") {
      return { data: [{ id: 7, name: "Shirts", code: "SH", articleCode: "SH-1" }] };
    }
    return { data: null, isLoading: false };
  },
  useMutation: (config: any) => {
    const mutation: any = {
      isPending: false,
      mutate: vi.fn(async (value?: any) => {
        try {
          const result = await config.mutationFn(value);
          config.onSuccess?.(result, value);
          return result;
        } catch (error) {
          config.onError?.(error, value);
          return undefined;
        }
      }),
    };
    return mutation;
  },
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: harness.toast }) }));
vi.mock("@/contexts/AppModeContext", () => ({ useAppMode: () => "factory" }));
vi.mock("@/lib/factoryApi", () => ({ getApiRequest: () => harness.modeApiRequest }));
vi.mock("@/hooks/use-admin-override", () => ({
  useAdminOverride: () => ({ wrapAdminAction: (action: () => void) => action(), AdminDialog: () => null }),
}));
vi.mock("@/components/BaleWeightEditDialog", () => ({ BaleWeightEditDialog: () => null }));
vi.mock("@/pages/barcodelookup/components/BaleStatusBadge", () => ({
  BaleStatusBadge: ({ status }: any) => <span data-testid="bale-status">{status}</span>,
}));
vi.mock("@/pages/barcodelookup/components/InfoRow", () => ({
  InfoRow: ({ label, value }: any) => (
    <div>
      {label}:{String(value ?? "")}
    </div>
  ),
}));

import BarcodeLookup from "@/pages/BarcodeLookup";

const referencePayload = {
  labelPrint: {
    id: 1,
    referenceNumber: "REF001",
    articleCode: "SH-1",
    approxWeightKg: "45",
    printedAt: "2026-08-10T10:00:00.000Z",
    printedByUserId: "admin-1",
    printedByName: "Admin",
    scannedAt: null,
    scannedByUserId: null,
    pieces: 1,
  },
  product: { id: 7, name: "Shirts", code: "SH", articleCode: "SH-1", active: true },
  baleInfo: {
    id: 12,
    baleCode: "B12",
    status: "IN_STOCK",
    weightKg: "45",
    costPerKg: "2",
    totalCost: "90",
    productName: "Shirts",
    grade: "A",
    stockEntryDate: "2026-08-10",
    pressedAt: null,
    finalizedAt: "2026-08-11T12:00:00.000Z",
    workerName: "Alice",
    createdAt: "2026-08-10T09:00:00.000Z",
    updatedAt: "2026-08-10T12:00:00.000Z",
    deletedAt: null,
  },
  locationInfo: { id: 11, name: "Main", city: "Lubumbashi", state: null },
  pressingBatch: null,
  mixBatch: null,
  containers_used: [],
  loadedOnOrder: null,
  auditHistory: [],
};

const articlePayload = {
  product: { id: 7, name: "Shirts", code: "SH", articleCode: "SH-1", active: true },
  labelPrints: [
    {
      id: 1,
      referenceNumber: "REF001",
      articleCode: "SH-1",
      approxWeightKg: "45",
      printedAt: "2026-08-10T10:00:00.000Z",
      scannedAt: null,
      baleStatus: "IN_STOCK",
    },
    {
      id: 2,
      referenceNumber: "REF002",
      articleCode: "SH-1",
      approxWeightKg: "45.5",
      printedAt: "2026-08-11T10:00:00.000Z",
      scannedAt: "2026-08-11T11:00:00.000Z",
      baleStatus: "SOLD",
    },
  ],
};

describe("barcode lookup page behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, "", "/barcode-lookup");
    harness.modeApiRequest.mockImplementation(async (method: string, path: string) => {
      if (method === "GET" && path.includes("/api/lookup/reference/")) {
        return { ok: true, json: async () => referencePayload };
      }
      if (method === "GET" && path.includes("/api/lookup/article/")) {
        return { ok: true, json: async () => articlePayload };
      }
      if (method === "POST" && path.endsWith("/scan")) {
        return {
          ok: true,
          json: async () => ({
            scannedAt: "2026-08-12T08:00:00.000Z",
            scannedByUserId: "admin-1",
            scannedByName: "Admin",
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });
  });

  it("auto-detects a reference number and renders its live bale details", async () => {
    render(<BarcodeLookup />);
    const input = screen.getByTestId("input-lookup-search");
    fireEvent.change(input, { target: { value: "REF001" } });
    expect(screen.getByTestId("button-toggle-search-mode")).toHaveTextContent("Ref #");
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(harness.modeApiRequest).toHaveBeenCalledWith("GET", "/api/lookup/reference/REF001"));
    expect(screen.getByTestId("text-reference-number")).toHaveTextContent("REF001");
    expect(screen.getByTestId("text-ref-article-code")).toHaveTextContent("SH-1");
    expect(screen.getByTestId("text-bale-product-name")).toHaveTextContent("Shirts");
    expect(screen.getByTestId("bale-status")).toHaveTextContent("IN_STOCK");
    expect(screen.getByText("Date Produced:2026-08-10")).toBeInTheDocument();
  });

  it("auto-detects article mode and lists every matching bale reference", async () => {
    render(<BarcodeLookup />);
    const input = screen.getByTestId("input-lookup-search");
    fireEvent.change(input, { target: { value: "SH-1" } });
    expect(screen.getByTestId("button-toggle-search-mode")).toHaveTextContent("Article");
    fireEvent.click(screen.getByTestId("button-lookup-search"));

    await waitFor(() => expect(harness.modeApiRequest).toHaveBeenCalledWith("GET", "/api/lookup/article/SH-1"));
    expect(screen.getByText("Shirts")).toBeInTheDocument();
    expect(screen.getByTestId("row-label-1")).toHaveTextContent("REF001");
    expect(screen.getByTestId("row-label-2")).toHaveTextContent("REF002");
    expect(screen.getByTestId("row-label-2")).toHaveTextContent("Scanned");
  });

  it("drills from an article row into the selected reference lookup", async () => {
    render(<BarcodeLookup />);
    const input = screen.getByTestId("input-lookup-search");
    fireEvent.change(input, { target: { value: "SH-1" } });
    fireEvent.click(screen.getByTestId("button-lookup-search"));
    await waitFor(() => expect(screen.getByTestId("row-label-1")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("row-label-1"));

    await waitFor(() => expect(harness.modeApiRequest).toHaveBeenCalledWith("GET", "/api/lookup/reference/REF001"));
    expect(input).toHaveValue("REF001");
  });

  it("loads a reference supplied in the URL query string automatically", async () => {
    window.history.replaceState({}, "", "/barcode-lookup?ref=REF001");
    render(<BarcodeLookup />);

    await waitFor(() => expect(harness.modeApiRequest).toHaveBeenCalledWith("GET", "/api/lookup/reference/REF001"));
    expect(screen.getByTestId("input-lookup-search")).toHaveValue("REF001");
    expect(screen.getByTestId("text-reference-number")).toHaveTextContent("REF001");
  });
});
