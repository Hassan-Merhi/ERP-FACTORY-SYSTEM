/**
 * Render-loop regressions found by the wave 4 page sweep.
 *
 * All three had the same cause: a `useQuery` result destructured with a
 * `= []` default is a brand-new array on every render while the query has no
 * data, and an effect keyed on that array reset state with a new object/array
 * — so the component re-rendered forever:
 *
 *  - Factory daybook "View entry" for any entry that is not voucher-backed
 *  - Price groups settings when the price-group request fails
 *  - Supplier Profit Check on open (covered in its own suite)
 *
 * Commits are counted with React's Profiler; a guard throws once the count is
 * clearly runaway, because a loop starves the timers vitest's timeout needs.
 */
import React, { Profiler } from "react";
import { act } from "@testing-library/react";
import { renderWithProviders } from "./helpers";
import { stubFetchRoutes } from "./pageMocks";

vi.mock("wouter", async () => (await import("./pageMocks")).wouterMock);
vi.mock("@/contexts/AppModeContext", async () => (await import("./pageMocks")).appModeMock);
vi.mock("@/contexts/CompanyContext", async () => (await import("./pageMocks")).companyMock);
vi.mock("@/contexts/CurrencyContext", async () => (await import("./pageMocks")).currencyMock);
vi.mock("@/contexts/DateFormatContext", async () => (await import("./pageMocks")).dateFormatMock);

import { ViewEntryModal } from "@/pages/factory/daybook/ViewEntryModal";
import { PriceGroupsTab } from "@/pages/settings/PriceGroupsTab";
import { Dialog, DialogContent } from "@/components/ui/dialog";

const RUNAWAY = 300;

function counted(ui: React.ReactElement) {
  const state = { commits: 0 };
  const onRender = () => {
    state.commits += 1;
    if (state.commits > RUNAWAY) throw new Error(`render loop: ${state.commits} commits`);
  };
  renderWithProviders(
    <Profiler id="subject" onRender={onRender}>
      {ui}
    </Profiler>
  );
  return state;
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

async function expectSettles(state: { commits: number }) {
  await settle();
  const settled = state.commits;
  await settle();
  expect(settled).toBeLessThan(30);
  expect(state.commits).toBe(settled);
}

const baseEntry = {
  id: 1,
  companyId: 1,
  txDate: "2026-09-01",
  description: "Entry",
  metaJson: "{}",
  currencyCode: "USD",
  amountCurrency: "100",
  fxRateToUsd: "1",
  amountUsd: "100",
  createdAt: "2026-09-01T10:00:00Z",
  createdBy: null,
};

describe("factory daybook View entry", () => {
  it.each([
    ["a container import", { txType: "CONTAINER_IMPORT", referenceTable: "factory_containers", referenceId: 5 }],
    ["a bale stock entry", { txType: "BALE_STOCK_ENTRY", referenceTable: null, referenceId: null }],
    ["a voucher-backed payment", { txType: "PAYMENT", referenceTable: "vouchers", referenceId: 9 }],
  ])("settles for %s", async (_label, fields) => {
    stubFetchRoutes();
    const state = counted(
      <Dialog open>
        <DialogContent>
          <ViewEntryModal
            entry={{ ...baseEntry, ...fields } as any}
            onClose={vi.fn()}
            onNavigate={vi.fn()}
            formatDisplayDate={(d) => d}
          />
        </DialogContent>
      </Dialog>
    );
    await expectSettles(state);
  });
});

describe("price groups settings", () => {
  it("settles when the price-group request fails", async () => {
    (global as any).fetch = vi.fn(async (url: string) =>
      String(url).startsWith("/api/location-price-groups")
        ? { ok: false, status: 500, json: async () => ({ message: "boom" }), text: async () => "boom" }
        : { ok: true, status: 200, json: async () => [], text: async () => "[]" }
    );
    const state = counted(<PriceGroupsTab />);
    await expectSettles(state);
  });

  it("settles with saved groups loaded", async () => {
    stubFetchRoutes({
      "/api/location-price-groups": [{ id: 1, name: "Retail", locationIds: [1] }],
      "/api/locations": [{ id: 1, name: "Main" }],
    });
    const state = counted(<PriceGroupsTab />);
    await expectSettles(state);
  });
});
