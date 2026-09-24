import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  PeriodFilter,
  getDefaultPeriodValue,
  parsePeriodFilterDate,
  type PeriodFilterValue,
} from "@/components/ui/period-filter";

vi.mock("@/contexts/DateFormatContext", () => ({
  useDateFormat: () => ({
    formatDisplayDate: (date: Date) => date.toISOString().slice(0, 10),
  }),
}));

function renderFilter(
  value: PeriodFilterValue = {
    fromDate: "2026-07-01",
    toDate: "2026-07-31",
    preset: "this_month",
  },
  onChange = vi.fn(),
  hideCustomInputs = false
) {
  render(<PeriodFilter value={value} onChange={onChange} hideCustomInputs={hideCustomInputs} />);
  return onChange;
}

describe("PeriodFilter interactions", () => {
  it("opens the custom-range dialog from the dropdown", async () => {
    const user = userEvent.setup();
    renderFilter();

    fireEvent.pointerDown(screen.getByTestId("period-filter-dropdown"), { button: 0, ctrlKey: false });
    await user.click(await screen.findByTestId("period-preset-custom"));

    expect(await screen.findByTestId("period-custom-range-dialog")).toBeInTheDocument();
    expect(screen.getByText("Select date range")).toBeInTheDocument();
  });

  it("closes the custom-range dialog with the footer Close button", async () => {
    const user = userEvent.setup();
    renderFilter();

    fireEvent.pointerDown(screen.getByTestId("period-filter-dropdown"), { button: 0, ctrlKey: false });
    await user.click(await screen.findByTestId("period-preset-custom"));
    expect(await screen.findByTestId("period-custom-range-dialog")).toBeInTheDocument();

    await user.click(screen.getByText("Close", { selector: "button" }));

    expect(screen.queryByTestId("period-custom-range-dialog")).not.toBeInTheDocument();
  });

  it("emits a complete value when a preset is selected", async () => {
    const user = userEvent.setup();
    const onChange = renderFilter();

    fireEvent.pointerDown(screen.getByTestId("period-filter-dropdown"), { button: 0, ctrlKey: false });
    await user.click(await screen.findByTestId("period-preset-yesterday"));

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        preset: "yesterday",
        fromDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        toDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      })
    );
  });

  it("does not expose custom-range controls when they are disabled", async () => {
    const user = userEvent.setup();
    renderFilter(undefined, vi.fn(), true);

    fireEvent.pointerDown(screen.getByTestId("period-filter-dropdown"), { button: 0, ctrlKey: false });

    expect(screen.queryByTestId("period-preset-custom")).not.toBeInTheDocument();
    expect(screen.queryByTestId("period-custom-range-dialog")).not.toBeInTheDocument();
  });

  it("creates valid default values for common presets", () => {
    expect(getDefaultPeriodValue("all_time")).toEqual({
      fromDate: "",
      toDate: "",
      preset: "all_time",
    });

    expect(getDefaultPeriodValue("today")).toEqual(
      expect.objectContaining({
        preset: "today",
        fromDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        toDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      })
    );
  });

  it("computes a correct, ordered range for every preset", () => {
    // getPresetDates has a branch per preset and they were largely unexercised.
    // Each one is pure, so this is cheap and it is what the whole date-filtered
    // reporting surface depends on being right.
    const presets = [
      "today",
      "yesterday",
      "this_week",
      "this_month",
      "last_1_month",
      "last_6_months",
      "this_year",
      "custom",
    ] as const;

    for (const preset of presets) {
      const v = getDefaultPeriodValue(preset);
      expect(v.preset, preset).toBe(preset);
      expect(v.fromDate, preset).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(v.toDate, preset).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // A period that ends before it starts would silently return no rows.
      expect(v.fromDate <= v.toDate, `${preset} range must not be inverted`).toBe(true);
    }
  });

  it("defaults to this_month when no preset is given", () => {
    expect(getDefaultPeriodValue().preset).toBe("this_month");
  });

  it("bounds last_1_month to the whole of the previous calendar month", () => {
    const v = getDefaultPeriodValue("last_1_month");
    const from = new Date(v.fromDate + "T12:00:00");
    const to = new Date(v.toDate + "T12:00:00");
    expect(from.getDate()).toBe(1);
    expect(from.getMonth()).toBe(to.getMonth());
    // last day of that month
    expect(new Date(to.getFullYear(), to.getMonth() + 1, 0).getDate()).toBe(to.getDate());
  });

  it("labels each named preset rather than showing raw dates", async () => {
    for (const [preset, label] of [
      ["all_time", "All Time"],
      ["today", "Today"],
      ["yesterday", "Yesterday"],
      ["this_week", "This Week"],
      ["this_month", "This Month"],
      ["this_year", "This Year"],
    ] as const) {
      const { unmount } = render(
        <PeriodFilter value={{ ...getDefaultPeriodValue(preset), preset }} onChange={vi.fn()} />
      );
      expect(await screen.findByText(label)).toBeInTheDocument();
      unmount();
    }
  });

  it("shows a joined range for a custom period and a single date when they match", () => {
    const { unmount } = render(
      <PeriodFilter value={{ fromDate: "2026-03-01", toDate: "2026-03-31", preset: "custom" }} onChange={vi.fn()} />
    );
    expect(screen.getByText("2026-03-01 – 2026-03-31")).toBeInTheDocument();
    unmount();

    render(
      <PeriodFilter value={{ fromDate: "2026-03-05", toDate: "2026-03-05", preset: "custom" }} onChange={vi.fn()} />
    );
    expect(screen.getByText("2026-03-05")).toBeInTheDocument();
  });

  it("falls back to a placeholder when a custom period has no dates", () => {
    render(<PeriodFilter value={{ fromDate: "", toDate: "", preset: "custom" }} onChange={vi.fn()} />);
    expect(screen.getByText("Custom Range")).toBeInTheDocument();
  });

  it("rejects malformed and impossible persisted date strings", () => {
    expect(parsePeriodFilterDate("not-a-date")).toBeUndefined();
    expect(parsePeriodFilterDate("2026-02-31")).toBeUndefined();
    expect(parsePeriodFilterDate("2026-13-01")).toBeUndefined();
    expect(parsePeriodFilterDate("2026-02-28")).toBeInstanceOf(Date);
  });

  it("does not crash when stale persisted custom dates are invalid", async () => {
    const user = userEvent.setup();

    expect(() =>
      renderFilter({
        fromDate: "not-a-date",
        toDate: "2026-02-31",
        preset: "custom",
      })
    ).not.toThrow();

    expect(screen.getByText("Custom Range")).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByTestId("period-filter-dropdown"), { button: 0, ctrlKey: false });
    await user.click(await screen.findByTestId("period-preset-custom"));

    expect(await screen.findByTestId("period-custom-range-dialog")).toBeInTheDocument();
  });
});
