import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import PressingBales from "@/pages/PressingBales";
import ProductionBales from "@/pages/ProductionBales";
import { apiRequest } from "@/lib/queryClient";

vi.mock("@/components/PageHeader", () => ({ PageHeader: () => null }));
vi.mock("@/components/CreateMixBatchDialog", () => ({ CreateMixBatchDialog: () => null }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/contexts/DateFormatContext", () => ({ useDateFormat: () => ({ formatDisplayDate: String }) }));
vi.mock("@/lib/queryClient", () => ({ apiRequest: vi.fn(), queryClient: { invalidateQueries: vi.fn() } }));

const clients: QueryClient[] = [];
const pending = {
  id: 101,
  productId: 3,
  referenceNumber: "REF/101 A",
  articleCode: "ART-1",
  productName: "Shirts",
  weightKg: "40",
  status: "PENDING_PRESSING",
  pressingBatchId: 8,
};
function setup(color?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  clients.push(client);
  client.setQueryData(
    ["/api/factory/bale-products"],
    [{ id: 3, name: "Shirts", code: "ART-1", articleCode: "ART-1", active: true, weightPerBaleKg: "40" }]
  );
  client.setQueryData(
    ["/api/factory/pressing-batches"],
    [{ id: 8, status: "PENDING", createdAt: "2026-10-10", pendingCount: 1, bales: [pending] }]
  );
  client.setQueryData(["/api/locations"], [{ id: 9, code: "WH", name: "Warehouse", active: true }]);
  client.setQueryData(
    ["/api/factory/mix-batches?profile=summary"],
    [{ id: 10, name: "Mix One", status: "ACTIVE", totalWeightKg: "100", usedKg: "0" }]
  );
  vi.mocked(apiRequest).mockImplementation(async (_method, url) => {
    if (url === "/api/factory/pressing/create-multi") return Response.json({ bales: [pending] });
    if (url.startsWith("/api/factory/bales/lookup/")) return Response.json({ bale: pending });
    if (url === "/api/factory/finalize") return Response.json({ finalizedCount: 1 });
    if (url === "/api/bale-label-prints")
      return Response.json({
        labelPrints: [
          {
            productionBaleId: 101,
            referenceNumber: pending.referenceNumber,
            articleCode: "ART-1",
            pieces: 1,
            approxWeightKg: "40",
          },
        ],
        priorityAllocations: color
          ? [
              {
                baleId: 101,
                referenceNumber: pending.referenceNumber,
                orderId: 77,
                priority: 1,
                color,
                existing: true,
                source: "reprint",
              },
            ]
          : [],
      });
    throw new Error(`Unexpected request: ${url}`);
  });
  const write = vi.fn();
  vi.spyOn(window, "open").mockReturnValue({
    document: { write, close: vi.fn() },
    focus: vi.fn(),
    print: vi.fn(),
  } as unknown as Window);
  return { client, write };
}
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function assertLabel(html: string, color?: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  expect(doc.querySelector('img[alt="Barcode"]')?.getAttribute("src")).toBe("/api/barcode/REF%2F101%20A");
  expect(doc.querySelector(".barcode-number")?.textContent).toBe(pending.referenceNumber);
  expect(doc.querySelector(".info-section")?.textContent).toContain("ART-1");
  expect(html).toContain("border-radius: 2mm");
  if (color) {
    const box = doc.querySelector(".priority-color-box") as HTMLElement;
    expect(box).not.toBeNull();
    expect(box.dataset.priorityColor).toBe(color.toLowerCase());
    expect(box.childNodes).toHaveLength(0);
    expect(box.style.getPropertyPriority("background-color")).toBe("important");
    expect(doc.querySelector(".logo-text")).toBeNull();
  } else {
    expect(doc.querySelector(".priority-color-box")).toBeNull();
    expect(doc.querySelector(".logo-text")?.textContent).toBe("HMD");
    expect(doc.querySelector(".logo-subtitle")?.textContent).toBe("INTERNATIONAL GROUP");
  }
}

describe("specialist label print actions", () => {
  it.each([undefined, "#B22222", "#123456"])(
    "Pressing prints the recorded color %s and original barcode",
    async (color) => {
      const { client, write } = setup(color);
      render(
        <QueryClientProvider client={client}>
          <PressingBales />
        </QueryClientProvider>
      );
      fireEvent.change(screen.getByTestId("input-scan"), { target: { value: "ART-1" } });
      fireEvent.keyDown(screen.getByTestId("input-scan"), { key: "Enter" });
      fireEvent.click(screen.getByTestId("button-create-print"));
      await waitFor(() => expect(write).toHaveBeenCalledOnce());
      const html = String(write.mock.calls[0][0]);
      expect(html).toContain("@page { size: 76mm 62mm");
      assertLabel(html, color);
    }
  );

  it.each([undefined, "#B22222", "#123456"])(
    "Production prints the recorded color %s and original barcode",
    async (color) => {
      const { client, write } = setup(color);
      const user = userEvent.setup();
      render(
        <QueryClientProvider client={client}>
          <ProductionBales />
        </QueryClientProvider>
      );
      fireEvent.click(screen.getByTestId("batch-card-8"));
      fireEvent.change(screen.getByTestId("input-finalize-scan"), { target: { value: pending.referenceNumber } });
      fireEvent.keyDown(screen.getByTestId("input-finalize-scan"), { key: "Enter" });
      await waitFor(() => expect(screen.getByTestId("badge-scan-count")).toHaveTextContent("1/1"));
      await user.click(screen.getByTestId("select-finalize-mix-batch"));
      await user.click(screen.getByRole("option", { name: /Mix One/ }));
      await user.click(screen.getByTestId("select-finalize-location"));
      await user.click(screen.getByRole("option", { name: /Warehouse/ }));
      fireEvent.click(screen.getByTestId("button-validate-finalize"));
      fireEvent.click(screen.getByTestId("button-confirm-finalize"));
      await waitFor(() => expect(write).toHaveBeenCalledOnce());
      assertLabel(String(write.mock.calls[0][0]), color);
    }
  );
});
