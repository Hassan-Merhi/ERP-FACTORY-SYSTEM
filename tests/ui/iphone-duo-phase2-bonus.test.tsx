import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductionBonusWeeklySheet, type BonusSheetWorker } from "@/pages/factory/productiontargets/ProductionBonusWeeklySheet";

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
    expect(within(card).getByText("$12.00")).toBeInTheDocument();
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
