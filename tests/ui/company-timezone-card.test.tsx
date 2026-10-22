import React from "react";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "./helpers";

const state = vi.hoisted(() => ({ timezone: null as string | null, requested: [] as string[] }));

vi.mock("@/contexts/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { id: 12, name: "HMD INT GROUP - BEIRUT" } }),
}));
vi.mock("@/contexts/AppModeContext", () => ({ useAppMode: () => "factory" }));
vi.mock("@/lib/factoryApi", () => ({ getApiRequest: () => vi.fn() }));

import { CompanyTimezoneCard } from "@/pages/settings/CompanyTimezoneCard";

beforeEach(() => {
  state.requested = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      state.requested.push(url);
      return { ok: true, json: async () => ({ companyId: 12, timezone: state.timezone }) } as Response;
    })
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("Company timezone card", () => {
  it("reads the selected company's settings and names the company", async () => {
    state.timezone = null;
    renderWithProviders(<CompanyTimezoneCard />);

    expect(await screen.findByText("Browser / Device local time")).toBeInTheDocument();
    expect(screen.getByText(/reports of HMD INT GROUP - BEIRUT/)).toBeInTheDocument();
    expect(state.requested).toContain("/api/company-settings?companyId=12");
  });

  it("shows a configured timezone", async () => {
    state.timezone = "Asia/Beirut";
    renderWithProviders(<CompanyTimezoneCard />);

    expect(await screen.findByText("Asia/Beirut (UTC+2/+3)")).toBeInTheDocument();
  });
});
