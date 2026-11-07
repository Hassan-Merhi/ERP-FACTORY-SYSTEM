import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductionBonusWeeklySheet, linkedDailyProgress, type BonusSheetWorker } from "@/pages/factory/productiontargets/ProductionBonusWeeklySheet";

vi.mock("@/contexts/ApplicationLanguageContext", () => ({
  useApplicationLanguage: () => ({ language: "en" }),
}));

const worker: BonusSheetWorker = {
  workerId: 18,
  workerName: "Factory Operator",
  days: [{
    date: "2026-11-05",
    target: 25,
    produced: 28,
    extra: 3,
    category: "Cotton",
    issue: null,
    status: "ready",
    linkGroupId: null,
  }],
  target: 25,
  produced: 28,
  extra: 3,
  amount: 12,
  weeklyAmount: 0,
  weeklyProjected: false,
  weeklyApproved: false,
  readyDays: 1,
  paidDays: 0,
  needsSetup: 0,
  blockedDays: 0,
  weeklyDays: 0,
};

afterEach(cleanup);

describe("iPhone Duo Phase 2 worker bonus cards", () => {
  it("renders a per-worker card without changing calculated totals", () => {
    render(<ProductionBonusWeeklySheet
      from="2026-11-05" to="2026-11-05" workers={[worker]} selected={[]}
      onToggle={vi.fn()} loading={false} />);
    const card = screen.getByTestId("bonus-mobile-worker-18");
    expect(within(card).getByText("Factory Operator")).toBeInTheDocument();
    expect(within(card).getByText(/\$12\.00/)).toBeInTheDocument();
    expect(screen.getByTestId("bonus-mobile-summary")).toBeInTheDocument();
  });

  it("keeps each worker's eligibility and selection independent", () => {
    const onToggle = vi.fn();
    render(<ProductionBonusWeeklySheet
      from="2026-11-05" to="2026-11-05" workers={[worker]} selected={[]}
      onToggle={onToggle} loading={false} />);
    fireEvent.click(within(screen.getByTestId("bonus-mobile-worker-18")).getByRole("checkbox"));
    expect(onToggle).toHaveBeenCalledWith(18, true);
  });

  it("keeps manual payment inputs controlled by the existing parent handler", () => {
    const onAmountChange = vi.fn();
    render(<ProductionBonusWeeklySheet from="2026-11-05" to="2026-11-05" workers={[worker]}
      selected={[18]} onToggle={vi.fn()} loading={false} manualMode
      manualAmounts={{ 18: "10.50" }} onAmountChange={onAmountChange} />);
    fireEvent.change(screen.getByTestId("bonus-mobile-amount-18"), { target: { value: "18.75" } });
    expect(onAmountChange).toHaveBeenCalledWith(18, "18.75");
  });

  it("retains daily actions in the mobile worker breakdown", () => {
    render(<ProductionBonusWeeklySheet from="2026-11-05" to="2026-11-05" workers={[worker]}
      selected={[]} onToggle={vi.fn()} loading={false}
      renderDayActions={(workerId, date) => <button type="button">{workerId}: {date}</button>} />);
    expect(within(screen.getByTestId("bonus-mobile-worker-18")).getByRole("button", {
      name: "18: 2026-11-05",
      hidden: true,
    })).toBeInTheDocument();
  });
});

describe("same-category linked daily target", () => {
  const linkedWorkers = (): BonusSheetWorker[] => [
    {
      ...worker, workerId: 18, workerName: "First Dress Worker",
      days: [{ ...worker.days[0], category: "DRESS", linkGroupId: 701, target: 10, produced: 0 }],
      target: 10, produced: 0, extra: 0, amount: 0,
    },
    {
      ...worker, workerId: 19, workerName: "Second Dress Worker",
      days: [{ ...worker.days[0], category: "DRESS", linkGroupId: 701, target: 10, produced: 16 }],
      target: 10, produced: 16, extra: 6, amount: 3,
    },
  ];

  it("combines each worker's production and target once for the same day/category", () => {
    const workers = linkedWorkers();
    const progress = linkedDailyProgress(workers[0], workers, "2026-11-05");
    expect(progress).toMatchObject({
      produced: 16, target: 20, linkedMemberIds: [18, 19], category: "DRESS",
    });
    render(<ProductionBonusWeeklySheet from="2026-11-05" to="2026-11-05"
      workers={workers} selected={[]} onToggle={vi.fn()} loading={false} />);
    const shared = screen.getByTestId("linked-daily-cell-2026-11-05-18");
    expect(shared).toHaveAttribute("rowspan", "2");
    expect(within(shared).getByText("16")).toBeInTheDocument();
    expect(within(shared).getByText("/ 20")).toBeInTheDocument();
    expect(within(shared).queryByLabelText("Target met")).not.toBeInTheDocument();
    expect(screen.queryByTestId("linked-daily-cell-2026-11-05-19")).not.toBeInTheDocument();
    // The footer uses raw per-worker credits, not the repeated shared display.
    expect(screen.getByTestId("bonus-mobile-summary")).toHaveTextContent("16 / 20");
    expect(within(screen.getByTestId("bonus-mobile-worker-18")).getByText("16 / 20")).toBeInTheDocument();
  });

  it("does not combine different categories despite the same link ID", () => {
    const workers = linkedWorkers();
    workers[1].days[0].category = "BLOUSE";
    expect(linkedDailyProgress(workers[0], workers, "2026-11-05")).toMatchObject({
      produced: 0, target: 10, linkedMemberIds: [18],
    });
    expect(linkedDailyProgress(workers[1], workers, "2026-11-05")).toMatchObject({
      produced: 16, target: 10, linkedMemberIds: [19],
    });
    render(<ProductionBonusWeeklySheet from="2026-11-05" to="2026-11-05"
      workers={workers} selected={[]} onToggle={vi.fn()} loading={false} />);
    expect(screen.queryByTestId("linked-daily-cell-2026-11-05-18")).not.toBeInTheDocument();
    expect(screen.getAllByLabelText("Target met").length).toBeGreaterThan(0);
  });

  it("does not join workers who were not linked on that historical day", () => {
    const workers = linkedWorkers();
    workers[1].days[0].linkGroupId = 702;
    expect(linkedDailyProgress(workers[0], workers, "2026-11-05")?.linkedMemberIds).toEqual([18]);
    workers[1].days[0].linkGroupId = null;
    expect(linkedDailyProgress(workers[0], workers, "2026-11-05")?.linkedMemberIds).toEqual([18]);
  });

  it("keeps per-worker day actions accessible inside the merged cell", () => {
    const workers = linkedWorkers();
    render(<ProductionBonusWeeklySheet from="2026-11-05" to="2026-11-05"
      workers={workers} selected={[]} onToggle={vi.fn()} loading={false}
      renderDayActions={(workerId) => <button type="button">Edit {workerId}</button>} />);
    const shared = screen.getByTestId("linked-daily-cell-2026-11-05-18");
    expect(within(shared).getByRole("button", { name: "Edit 18", hidden: true })).toBeInTheDocument();
    expect(within(shared).getByRole("button", { name: "Edit 19", hidden: true })).toBeInTheDocument();
  });
});
