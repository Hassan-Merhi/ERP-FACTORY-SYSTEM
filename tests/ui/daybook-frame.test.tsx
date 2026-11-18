import React from "react";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";

vi.mock("@/pages/settings/AuditLog", () => ({ AuditLog: () => <div>Audit activity</div> }));
vi.mock("@/contexts/DateFormatContext", async () => (await import("./pageMocks")).dateFormatMock);

import { DaybookFilterBar } from "@/components/daybook/DaybookFilterBar";
import { DaybookKpiStrip, DaybookTableState, DaybookTabs } from "@/components/daybook/DaybookFrame";
import { useDaybookTab, type DaybookTab } from "@/components/daybook/useDaybookTab";
import { ReceiptText } from "lucide-react";

function TabsHarness({ visible = ["transactions", "activity"] as DaybookTab[], ready = true }) {
  const [tab, setTab] = useDaybookTab(visible, ready);
  return (
    <DaybookTabs value={tab} onValueChange={setTab} tabs={visible}>
      <div>Transactions panel</div>
    </DaybookTabs>
  );
}

describe("Daybook tab URL state", () => {
  beforeEach(() => window.history.replaceState({}, "", "/daybook"));

  it("opens Transactions for a link without ?tab and keeps the URL clean", () => {
    render(<TabsHarness />);
    expect(screen.getByRole("tab", { name: "Transactions" })).toHaveAttribute("data-state", "active");
    expect(screen.getByText("Transactions panel")).toBeInTheDocument();
    expect(window.location.search).toBe("");
  });

  it("moves to Edits & Activity in ?tab=activity and back to a clean URL", async () => {
    window.history.replaceState({}, "", "/daybook?date=2026-08-10");
    render(<TabsHarness />);
    act(() => screen.getByRole("tab", { name: "Edits & Activity" }).click());
    expect(await screen.findByText("Audit activity")).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toBe("?date=2026-08-10&tab=activity"));

    act(() => screen.getByRole("tab", { name: "Transactions" }).click());
    await waitFor(() => expect(window.location.search).toBe("?date=2026-08-10"));
  });

  it("reopens the tab named in the link", () => {
    window.history.replaceState({}, "", "/factory/daybook?tab=activity");
    render(<TabsHarness />);
    expect(screen.getByRole("tab", { name: "Edits & Activity" })).toHaveAttribute("data-state", "active");
    expect(screen.getByText("Audit activity")).toBeInTheDocument();
  });

  it("drops an unknown tab and falls back to the first visible one", () => {
    window.history.replaceState({}, "", "/daybook?tab=vouchers");
    const { result } = renderHook(() => useDaybookTab());
    expect(result.current[0]).toBe("transactions");
    expect(window.location.search).toBe("");
  });

  it("keeps a deep-linked tab while permissions load and settles once they arrive", () => {
    window.history.replaceState({}, "", "/factory/daybook?tab=activity");
    const { result, rerender } = renderHook(({ visible, ready }) => useDaybookTab(visible, ready), {
      initialProps: { visible: [] as DaybookTab[], ready: false },
    });
    expect(result.current[0]).toBe("activity");
    expect(window.location.search).toBe("?tab=activity");

    rerender({ visible: ["transactions"], ready: true });
    expect(result.current[0]).toBe("transactions");
    expect(window.location.search).toBe("");
  });
});

describe("Daybook filter bar", () => {
  it("steps the day, removes a chip and resets every filter", () => {
    const onPrevDay = vi.fn();
    const onNextDay = vi.fn();
    const removeType = vi.fn();
    const clear = vi.fn();
    const onSearchChange = vi.fn();
    render(
      <DaybookFilterBar
        period={{ fromDate: "2026-08-11", toDate: "2026-08-11", preset: "custom" }}
        onPeriodChange={vi.fn()}
        onPrevDay={onPrevDay}
        onNextDay={onNextDay}
        search=""
        onSearchChange={onSearchChange}
        searchPlaceholder="Search..."
        activeCount={1}
        chips={[{ id: "type", label: "Payment", onRemove: removeType, testId: "chip-type" }]}
        hasActiveFilters
        onClearFilters={clear}
      >
        <div data-testid="page-dropdown" />
      </DaybookFilterBar>
    );

    expect(screen.getByRole("search", { name: "Daybook filters" })).toContainElement(
      screen.getByTestId("page-dropdown")
    );
    fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
    fireEvent.click(screen.getByRole("button", { name: "Next day" }));
    expect(onPrevDay).toHaveBeenCalledTimes(1);
    expect(onNextDay).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByTestId("input-search"), { target: { value: "rent" } });
    expect(onSearchChange).toHaveBeenCalledWith("rent");

    fireEvent.click(screen.getByTestId("chip-type"));
    expect(removeType).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("button-reset-filters"));
    expect(clear).toHaveBeenCalled();
  });

  it("hides the chip row when nothing is filtered", () => {
    render(
      <DaybookFilterBar
        period={{ fromDate: "2026-08-11", toDate: "2026-08-11", preset: "today" }}
        onPeriodChange={vi.fn()}
        search=""
        onSearchChange={vi.fn()}
        searchPlaceholder="Search..."
        activeCount={0}
        hasActiveFilters={false}
        onClearFilters={vi.fn()}
      />
    );
    expect(screen.queryByTestId("button-reset-filters")).toBeNull();
    expect(screen.queryByRole("button", { name: "Previous day" })).toBeNull();
  });
});

describe("Daybook table states and KPIs", () => {
  it("shows the failure with a retry instead of an empty day", () => {
    const retry = vi.fn();
    render(<DaybookTableState isLoading={false} errorMessage="No access" onRetry={retry} isEmpty />);
    expect(screen.getByTestId("daybook-error")).toHaveTextContent("No access");
    fireEvent.click(screen.getByTestId("button-daybook-retry"));
    expect(retry).toHaveBeenCalled();
    expect(screen.queryByTestId("daybook-empty")).toBeNull();
  });

  it("shows loading, then the page's own empty message and action", () => {
    const { rerender } = render(<DaybookTableState isLoading isEmpty />);
    expect(screen.getByTestId("daybook-loading")).toBeInTheDocument();
    rerender(
      <DaybookTableState
        isLoading={false}
        isEmpty
        emptyTitle="No transactions found"
        emptyAction={<button type="button">New Sale</button>}
      />
    );
    expect(screen.getByTestId("daybook-empty")).toHaveTextContent("No transactions found");
    expect(screen.getByRole("button", { name: "New Sale" })).toBeInTheDocument();
  });

  it("renders nothing when there are rows to show", () => {
    const { container } = render(<DaybookTableState isLoading={false} isEmpty={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders each KPI with its value", () => {
    render(
      <DaybookKpiStrip
        items={[{ id: "sales", label: "Sales", value: "12", icon: ReceiptText, tone: "count", testId: "kpi-sales" }]}
      />
    );
    expect(screen.getByTestId("daybook-overview")).toHaveTextContent("Sales");
    expect(screen.getByTestId("kpi-sales")).toHaveTextContent("12");
  });
});
