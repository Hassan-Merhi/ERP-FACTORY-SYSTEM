import { render, screen, waitFor } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { describe, expect, it } from "vitest";
import { ReadOnlyRoleRouteGate } from "@/components/ReadOnlyRoleRouteGate";

function renderGate(role: string, path: string) {
  const location = memoryLocation({ path, record: true });
  render(
    <Router hook={location.hook}>
      <ReadOnlyRoleRouteGate role={role}>
        <div data-testid="page">page</div>
      </ReadOnlyRoleRouteGate>
    </Router>
  );
  return location;
}

describe("ReadOnlyRoleRouteGate", () => {
  it("renders pages unchanged for legacy roles", () => {
    renderGate("Owner", "/import-stock-items");
    expect(screen.getByTestId("page")).toBeInTheDocument();
    expect(screen.queryByTestId("read-only-role-route-notice")).not.toBeInTheDocument();
  });

  it("explains instead of opening a change page for View Only", () => {
    renderGate("View Only", "/import-stock-items");
    expect(screen.queryByTestId("page")).not.toBeInTheDocument();
    const notice = screen.getByTestId("read-only-role-route-notice");
    expect(notice).toHaveAttribute("role", "status");
    expect(notice).toHaveTextContent("This page changes existing records.");
    expect(screen.getByRole("button", { name: "Go back" })).toBeInTheDocument();
  });

  it("explains an unverified create page for Create Only", () => {
    renderGate("Create Only", "/stock-transfer-order");
    expect(screen.getByTestId("read-only-role-route-notice")).toHaveTextContent("not available to Create Only users");
  });

  it("opens a verified create page for Create Only", () => {
    renderGate("Create Only", "/factory/sales/new");
    expect(screen.getByTestId("page")).toBeInTheDocument();
  });

  it("sends a voucher edit link to the read-only voucher view", async () => {
    const location = renderGate("Create Only", "/vouchers/12/edit");
    await waitFor(() => expect(location.history.at(-1)).toBe("/voucher-detail/12"));
  });
});
