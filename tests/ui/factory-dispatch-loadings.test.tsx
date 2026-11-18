import React from "react";
import { cleanup, screen } from "@testing-library/react";
import { renderWithProviders } from "./helpers";
import { installFakeApi, type FakeApi } from "./fakeApi";

/**
 * /factory/dispatch-batches keeps its page key and route but, with the Dispatch Batches list
 * retired, shows Container Loadings. It must never show that view to someone the Invoicing
 * loadings tab or either old Dispatch Batches tab was hidden from, and it never redirects (a
 * Dispatch Batches landing page would otherwise loop).
 */

vi.mock("@/contexts/CompanyContext", async () => (await import("./pageMocks")).companyMock);
vi.mock("@/pages/factory/FactoryContainerLoadingScan", () => ({
  default: () => <div data-testid="container-loadings" />,
}));

let api: FakeApi;
afterEach(() => {
  cleanup();
  api.restore();
});

async function renderWith(access: { fullAccess?: boolean; pageKeys?: string[]; hidden?: string[] }) {
  api = installFakeApi();
  api.get("/api/factory/my-access", {
    fullAccess: access.fullAccess ?? false,
    pageKeys: access.pageKeys ?? [],
    hasErpAccess: false,
    hasFactoryAccess: true,
    hiddenCostFields: access.hidden ?? [],
    hideAllCosts: false,
    companyId: 1,
    companyName: "Factory",
  });
  const { default: FactoryDispatchLoadings } = await import("@/pages/factory/FactoryDispatchLoadings");
  renderWithProviders(<FactoryDispatchLoadings />);
}

describe("Dispatch Batches route after the list's retirement", () => {
  it("shows Container Loadings to a user who can open the Invoicing loadings tab", async () => {
    await renderWith({ pageKeys: ["factory/dispatch-batches", "factory/invoicing"] });
    expect(await screen.findByTestId("container-loadings")).toBeInTheDocument();
  });

  it("shows it to full-access users", async () => {
    await renderWith({ fullAccess: true });
    expect(await screen.findByTestId("container-loadings")).toBeInTheDocument();
  });

  it("does not widen access for a Dispatch Batches-only user", async () => {
    await renderWith({ pageKeys: ["factory/dispatch-batches"] });
    expect(await screen.findByTestId("restricted-tabs-state")).toBeInTheDocument();
    expect(screen.queryByTestId("container-loadings")).toBeNull();
  });

  it.each(["hide_invoicing_loadings_tab", "hide_tab_dispatch_batches", "hide_tab_dispatch_reports"])(
    "stays closed when %s is hidden",
    async (key) => {
      await renderWith({ pageKeys: ["factory/dispatch-batches", "factory/invoicing"], hidden: [key] });
      expect(await screen.findByTestId("restricted-tabs-state")).toBeInTheDocument();
      expect(screen.queryByTestId("container-loadings")).toBeNull();
    }
  );
});
