/**
 * The phases 23–29 pages on the #2173 responsiveness conventions, checked on
 * rendered output: preview lists are one capped Table region (no hand-made
 * scroll box around a table), the supplier ledger lines are one region with
 * logical alignment, and the FX Rates entry row stacks full width on phones.
 */
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "./helpers";

vi.mock("@/lib/queryClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queryClient")>();
  return { ...actual, apiRequestPrivileged: vi.fn(), apiRequest: vi.fn(), getAppDate: () => "2026-10-11" };
});
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { RateFileImportPanel } from "@/pages/accounting-cleanup/RateFileImportPanel";
import { PlanFigures } from "@/pages/accounting-cleanup/cleanupPlanView";
import { FactorySupplierLedgerLines } from "@/pages/factory/factory-suppliers/FactorySupplierLedgerLines";
import { FxRatesCard } from "@/pages/settings/FxRatesCard";

const owner = {
  seedQueries: [[["/api/auth/me"], { id: "u1", username: "owner", role: "Owner", currentRole: "Owner" }]] as const,
};

afterEach(() => vi.clearAllMocks());

function expectSingleCappedRegion(region: HTMLElement, maxHeight: string) {
  expect(region).toHaveAttribute("data-table-scroll-region", "true");
  expect(region).toHaveAttribute("data-scroll-mode", "capped");
  expect(region.style.maxHeight).toBe(maxHeight);
  // The region owns its scroll: nothing between it and the card scrolls too.
  expect(region.parentElement?.className ?? "").not.toMatch(/overflow-(auto|x-auto|y-auto)/);
  expect(region.parentElement?.closest("[data-table-scroll-region]")).toBeNull();
}

describe("phases 23–29 responsive layout", () => {
  it("previews a rates file in one capped table region", async () => {
    renderWithProviders(
      <RateFileImportPanel
        kind="factory"
        recorded={[]}
        importUrl="/api/factory/fx-rates/batch"
        today="2026-10-11"
        onSaved={vi.fn()}
      />
    );
    const file = new File(["currency,date,rate_to_usd\nEUR,2026-03-26,1.1539\n"], "rates.csv", { type: "text/csv" });
    fireEvent.change(screen.getByTestId("input-rate-file-factory"), { target: { files: [file] } });
    await screen.findByTestId("row-rate-import-EUR-2026-03-26");
    expectSingleCappedRegion(screen.getByRole("region", { name: "Rates file preview" }), "20rem");
  });

  it("lists a plan's rows in one capped table region named after the list", () => {
    renderWithProviders(
      <PlanFigures plan={{ rows: [{ voucherNumber: "JV-1", amount: "10.00" }] }} testId="plan-test" />
    );
    expect(screen.getByTestId("plan-test-rows")).toHaveTextContent("JV-1");
    expectSingleCappedRegion(screen.getAllByRole("region")[0], "20rem");
  });

  it("shows the supplier ledger lines as one table region aligned with logical properties", () => {
    renderWithProviders(
      <FactorySupplierLedgerLines
        lines={[]}
        openingBalanceUsd="0.00"
        formatDate={(value) => value}
        formatNum={(value) => value}
      />
    );
    const region = screen.getByRole("region", { name: "Supplier ledger lines" });
    expect(screen.getByTestId("table-supplier-ledger-lines").className).not.toContain("overflow-x-auto");
    expect(region.parentElement).toBe(screen.getByTestId("table-supplier-ledger-lines"));
    for (const header of screen.getAllByRole("columnheader").slice(3)) {
      expect(header.className).toContain("text-end");
      expect(header.className).not.toContain("text-right");
    }
  });

  it("stacks the FX Rates entry fields full width on phones and sizes them from sm", async () => {
    (global as unknown as { fetch: unknown }).fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [],
    }));
    renderWithProviders(<FxRatesCard />, owner);
    const currency = await screen.findByTestId("input-fxrate-currency");
    const row = currency.parentElement as HTMLElement;
    expect(row.className).toContain("grid-cols-1");
    expect(row.className).toContain("min-[420px]:grid-cols-2");
    expect(row.className).toContain("sm:flex");
    for (const [testId, width] of [
      ["input-fxrate-currency", "sm:w-36"],
      ["input-fxrate-rate", "sm:w-48"],
      ["input-fxrate-date", "sm:w-44"],
    ]) {
      const input = screen.getByTestId(testId);
      expect(input.className).toContain("w-full");
      expect(input.className).toContain(width);
    }
  });
});
