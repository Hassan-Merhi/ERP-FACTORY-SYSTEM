/**
 * Supplier Profit Check must settle after it opens. With no supplier chosen
 * the analysis query is disabled; its `= []` default used to be a new array
 * every render, and the effect that seeds quantities from the rows then set a
 * new qtyMap each time — the page re-rendered forever (over 100k renders in
 * 30s under jsdom, a pegged CPU in the browser). Found by the wave 4 page
 * sweep; this counts real model renders through a stubbed view.
 */
import React from "react";
import { act } from "@testing-library/react";
import { renderWithProviders } from "./helpers";
import { resetPageState, stubFetchRoutes, stubSeededFetch } from "./pageMocks";

vi.mock("wouter", async () => (await import("./pageMocks")).wouterMock);
vi.mock("@/contexts/CompanyContext", async () => (await import("./pageMocks")).companyMock);
vi.mock("@/contexts/CurrencyContext", async () => (await import("./pageMocks")).currencyMock);
vi.mock("@/contexts/DateFormatContext", async () => (await import("./pageMocks")).dateFormatMock);

const renders = vi.hoisted(() => ({ count: 0, last: null as any }));
vi.mock("@/pages/supplierprofitcheck/SupplierProfitCheckView", () => ({
  SupplierProfitCheckView: ({ model }: { model: unknown }) => {
    renders.count += 1;
    renders.last = model;
    // A render loop starves the timers vitest's own timeout relies on, so fail
    // from inside the loop instead of hanging the run.
    if (renders.count > 200) throw new Error(`SupplierProfitCheck re-rendered ${renders.count} times`);
    return null;
  },
}));

import SupplierProfitCheck from "@/pages/SupplierProfitCheck";

async function settle() {
  // Several macrotask turns: an effect loop would keep adding renders here.
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

beforeEach(() => {
  resetPageState();
  renders.count = 0;
  renders.last = null;
});

describe("Supplier Profit Check render stability", () => {
  it("settles with no supplier selected and empty data", async () => {
    stubFetchRoutes();
    renderWithProviders(<SupplierProfitCheck />);
    await settle();
    const settled = renders.count;
    await settle();

    expect(settled).toBeLessThan(15);
    expect(renders.count).toBe(settled);
    expect(renders.last.supplierId).toBe("");
    expect(renders.last.qtyMap).toEqual({});
  });

  it("settles with suppliers and lookups loaded", async () => {
    stubSeededFetch();
    renderWithProviders(<SupplierProfitCheck />);
    await settle();
    const settled = renders.count;
    await settle();

    expect(settled).toBeLessThan(15);
    expect(renders.count).toBe(settled);
  });
});
