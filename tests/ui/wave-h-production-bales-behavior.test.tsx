import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  toast: vi.fn(),
  invalidateQueries: vi.fn(),
}));

vi.mock("@/lib/queryClient", () => ({
  apiRequest: harness.apiRequest,
  queryClient: { invalidateQueries: harness.invalidateQueries },
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: harness.toast }) }));
vi.mock("@/hooks/use-escape-back", () => ({ useEscapeBack: vi.fn() }));
vi.mock("@/contexts/DateFormatContext", () => ({
  useDateFormat: () => ({ formatDisplayDate: (value: unknown) => String(value) }),
}));
vi.mock("@/components/CreateMixBatchDialog", () => ({ CreateMixBatchDialog: () => null }));

import ProductionBales from "@/pages/ProductionBales";

function response(body: unknown, ok = true) {
  return {
    ok,
    json: async () => body,
  };
}

function renderProductionBales() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  client.setQueryData(
    ["/api/factory/pressing-batches"],
    [
      {
        id: 44,
        status: "PARTIALLY_FINALIZED",
        createdAt: "2026-08-20",
        pendingCount: 2,
        finalizedCount: 1,
        bales: [
          {
            id: 101,
            pressingBatchId: 44,
            referenceNumber: "BAL-101",
            articleCode: "A101",
            productName: "White Bale",
            weightKg: "25",
            status: "PENDING_PRESSING",
          },
          {
            id: 102,
            pressingBatchId: 44,
            referenceNumber: "BAL-102",
            articleCode: "A102",
            productName: "Blue Bale",
            weightKg: "30",
            status: "PENDING_PRESSING",
          },
        ],
      },
    ]
  );
  client.setQueryData(
    ["/api/locations"],
    [
      { id: 7, code: "WH", name: "Warehouse", active: true },
      { id: 8, code: "OLD", name: "Inactive", active: false },
    ]
  );
  client.setQueryData(
    ["/api/factory/mix-batches?profile=summary"],
    [
      { id: 9, batchCode: "MIX-9", name: "Daily Mix", totalWeightKg: "100", usedKg: "20", status: "ACTIVE" },
      { id: 10, batchCode: "MIX-10", name: "Closed Mix", totalWeightKg: "100", usedKg: "100", status: "CLOSED" },
    ]
  );

  return render(
    <QueryClientProvider client={client}>
      <ProductionBales />
    </QueryClientProvider>
  );
}

describe("Wave H production finalize behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens a pending batch, verifies a scanned bale, removes it, and reports invalid scans", async () => {
    harness.apiRequest.mockImplementation(async (_method: string, url: string) => {
      if (url.includes("BAD-STATUS")) {
        return response({ bale: { id: 101, pressingBatchId: 44, status: "FINALIZED" } });
      }
      if (url.includes("WRONG-BATCH")) {
        return response({ bale: { id: 999, pressingBatchId: 55, status: "PENDING_PRESSING" } });
      }
      return response({
        bale: {
          id: 101,
          pressingBatchId: 44,
          referenceNumber: "BAL-101",
          articleCode: "A101",
          productName: "White Bale",
          weightKg: "25",
          status: "PENDING_PRESSING",
        },
      });
    });

    renderProductionBales();

    expect(await screen.findByTestId("badge-finalize-mode")).toHaveTextContent("FINALIZE MODE");
    expect(screen.getByTestId("batch-card-44")).toHaveTextContent("2 pending");
    expect(screen.getByTestId("batch-card-44")).toHaveTextContent("1 finalized");
    expect(screen.getByTestId("batch-card-44")).toHaveTextContent("1x White Bale");
    expect(screen.getByTestId("batch-card-44")).toHaveTextContent("1x Blue Bale");

    fireEvent.click(screen.getByTestId("batch-card-44"));
    expect(await screen.findByTestId("text-batch-title")).toHaveTextContent("Batch #44");
    expect(screen.getByTestId("text-expected-count")).toHaveTextContent("2");
    fireEvent.click(screen.getByTestId("select-finalize-mix-batch"));
    expect(await screen.findByText(/Daily Mix/)).toBeInTheDocument();
    expect(screen.queryByText(/Closed Mix/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(/Daily Mix/));

    const scan = screen.getByTestId("input-finalize-scan");
    fireEvent.change(scan, { target: { value: "BAL-101" } });
    fireEvent.keyDown(scan, { key: "Enter" });

    await waitFor(() => expect(screen.getByTestId("text-scanned-count")).toHaveTextContent("1"));
    expect(screen.getByTestId("badge-scan-count")).toHaveTextContent("1/2 scanned");
    expect(screen.getByText("1 missing")).toBeInTheDocument();
    expect(screen.getByTestId("button-remove-scanned-101")).toBeInTheDocument();
    expect(harness.apiRequest).toHaveBeenCalledWith("GET", expect.stringContaining("BAL-101"));

    fireEvent.click(screen.getByTestId("button-remove-scanned-101"));
    await waitFor(() => expect(screen.getByTestId("text-scanned-count")).toHaveTextContent("0"));

    fireEvent.change(scan, { target: { value: "BAD-STATUS" } });
    fireEvent.keyDown(scan, { key: "Enter" });
    expect(await screen.findByTestId("text-scan-error")).toHaveTextContent("Bale is not pending");

    fireEvent.change(scan, { target: { value: "WRONG-BATCH" } });
    fireEvent.keyDown(scan, { key: "Enter" });
    expect(await screen.findByTestId("text-scan-error")).toHaveTextContent("does not belong to this pressing batch");

    fireEvent.click(screen.getByTestId("button-back-to-batches"));
    expect(await screen.findByTestId("batch-card-44")).toBeInTheDocument();
  });
});
