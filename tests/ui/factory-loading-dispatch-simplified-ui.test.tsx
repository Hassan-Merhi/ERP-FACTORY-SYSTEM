import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import Overview from "@/pages/factory/FactoryLoadingDispatchOverview";
import Detail from "@/pages/factory/FactoryLoadingDispatchDetail";

vi.mock("@/pages/factory/FactoryLoadingDispatchScanner", () => ({
  default: ({ embedded }: { embedded: boolean }) => embedded && <input aria-label="Bale barcode" />,
}));
vi.mock("@/pages/factory/FactoryLoadingDispatchLifecycle", () => ({
  default: ({ compact }: { compact: boolean }) => compact && <button>End Dispatch</button>,
}));
vi.mock("@/pages/factory/FactoryLoadingDispatchFinance", () => ({
  default: () => <section>Financial preview</section>,
}));
vi.mock("@/pages/factory/FactoryLoadingDispatchPostingPanel", () => ({
  default: () => <section>Posting panel</section>,
}));
afterEach(cleanup);

function view(detail: boolean, privileged = false, status = "OPEN") {
  const trip = { id: 11, dispatchNumber: 2, status, scannedBales: 3, scannedWeightKg: 120 };
  const state = {
    orderId: 7,
    dispatchId: 11,
    companyId: 1,
    completion: 60,
    loadedQty: 5,
    verifiedQty: 3,
    remainingQty: 2,
    trips: [trip],
    visibleTrips: [trip],
    tripsQuery: { data: { containerNumber: "C-1" } },
    selectedTrip: trip,
    filter: "all",
    openTrips: 1,
    loadedWeight: 200,
    verifiedWeight: 120,
    canCreate: privileged,
    canEdit: privileged,
    canDeleteDispatch: privileged,
    canViewFinancialDashboard: privileged,
    formatDisplayDateTime: () => "",
    navigate: vi.fn(),
    refresh: vi.fn(),
    setFilter: vi.fn(),
    setDeleteOpen: vi.fn(),
    setDeleteReason: vi.fn(),
  };
  const props = state as unknown as ComponentProps<typeof Detail>["state"];
  render(
    <QueryClientProvider client={new QueryClient()}>
      {detail ? <Detail state={props} /> : <Overview state={props} />}
    </QueryClientProvider>
  );
  return state;
}
describe("dispatch management", () => {
  it("opens the selected trip from the overview and hides financial tabs for an operator", () => {
    const state = view(false);
    fireEvent.click(screen.getByRole("button", { name: "Open trip 2" }));
    expect(state.navigate).toHaveBeenCalledWith("/factory/sales/loading/dispatch/7/11");
    expect(screen.queryByRole("tab", { name: "Charges" })).toBeNull();
    expect(screen.getByText("Not yet scanned").parentElement).toHaveTextContent("2");
  });
  it("offers authorized users the charges and final invoice tabs", () => {
    view(false, true);
    expect(screen.getByRole("tab", { name: "Charges" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Final Invoice" })).toBeVisible();
  });
  it("shows inline scanning and completion while keeping comparison and refresh available", () => {
    const state = view(true);
    expect(screen.getByRole("textbox", { name: "Bale barcode" })).toBeVisible();
    expect(screen.getByRole("button", { name: "End Dispatch" })).toBeVisible();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "60");
    fireEvent.click(screen.getByTestId("button-compare-dispatch"));
    expect(state.navigate).toHaveBeenCalledWith("/factory/sales/loading/dispatch/7/compare");
    fireEvent.click(screen.getByTestId("button-refresh-trip-detail"));
    expect(state.refresh).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("dispatch-toggle-trip-options")).toBeNull();
  });
  it("reveals financial and edit controls on demand and opens the deletion confirmation", () => {
    const state = view(true, true);
    expect(screen.queryByText("Financial preview")).toBeNull();
    fireEvent.click(screen.getByTestId("dispatch-toggle-trip-options"));
    expect(screen.getByText("Financial preview")).toBeVisible();
    expect(screen.getByText("Posting panel")).toBeVisible();
    expect(screen.getByTestId("button-edit-dispatch")).toBeVisible();
    fireEvent.click(screen.getByTestId("button-delete-dispatch"));
    expect(state.setDeleteReason).toHaveBeenCalledWith("");
    expect(state.setDeleteOpen).toHaveBeenCalledWith(true);
    expect(screen.queryByText(/ERP PO Excel export/i)).toBeNull();
  });
  it("keeps completed trips out of the deletion flow", () => {
    view(true, true, "CLOSED");
    fireEvent.click(screen.getByTestId("dispatch-toggle-trip-options"));
    expect(screen.queryByTestId("button-delete-dispatch")).toBeNull();
  });
});
