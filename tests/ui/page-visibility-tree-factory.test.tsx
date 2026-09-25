import React from "react";
import { screen, waitFor } from "@testing-library/react";

import { PageVisibilityTree } from "@/pages/settings/PageVisibilityTree";

import { renderWithProviders } from "./helpers";

vi.mock("@/contexts/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { id: 7, name: "Test Co" } }),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const fetchMock = vi.fn();
const rolePermissionRequests = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/settings/role-permissions"));

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve([{ role: "Owner", featureKey: "sales_report", enabled: true }]),
    headers: new Headers(),
  });
  (global as any).fetch = fetchMock;
});

// Factory page/tab permissions are per user (Users & Permissions). Settings must
// not render a second, role-based Factory tree: that copy is where placeholder
// mappings and the retired V2/V3 stock-allocation pages kept reappearing.
describe("PageVisibilityTree", () => {
  it("in Factory mode points to per-user management and loads no role tree", async () => {
    renderWithProviders(<PageVisibilityTree appMode="factory" />);

    const notice = screen.getByTestId("factory-visibility-managed-per-user");
    expect(notice).toHaveTextContent("User Management");
    expect(notice).toHaveTextContent("Select a user to manage their account, access, and permissions.");
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(rolePermissionRequests()).toEqual([]);
  });

  it("in ERP mode renders only ERP features, with no placeholder or retired Factory keys", async () => {
    renderWithProviders(<PageVisibilityTree appMode="erp" />);

    await waitFor(() => expect(screen.getByTestId("switch-visibility-Owner-sales_report")).toBeChecked());
    expect(rolePermissionRequests()).toHaveLength(1);
    expect(screen.queryByTestId("factory-visibility-managed-per-user")).toBeNull();
    expect(screen.queryByText(/Needs mapping/i)).toBeNull();

    const switchIds = screen.getAllByRole("switch").map((control) => control.getAttribute("data-testid"));
    expect(switchIds.length).toBeGreaterThan(0);
    expect(switchIds.filter((id) => id?.includes("factory"))).toEqual([]);
  });
});
