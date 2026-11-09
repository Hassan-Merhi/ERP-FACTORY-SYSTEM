import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ErpPage } from "./ErpPage";

// The header's navigation hooks are already tested in PageHeader's suite.
// Keep this contract test focused on ERP composition and prop forwarding.
vi.mock("@/components/PageHeader", () => ({
  PageHeader: ({
    title,
    subtitle,
    meta,
    children,
  }: {
    title: ReactNode;
    subtitle?: ReactNode;
    meta?: ReactNode;
    children?: ReactNode;
  }) => (
    <header>
      <h1>{title}</h1>
      {subtitle ? <p>{subtitle}</p> : null}
      {meta}
      {children}
    </header>
  ),
}));

describe("ERP page foundation", () => {
  it("preserves the canonical padded shell and places actions in the header", () => {
    render(
      <ErpPage
        title="Opening Stock"
        subtitle="Company"
        meta={<span>Current period</span>}
        headerActions={<button type="button">Refresh</button>}
        data-testid="erp-page"
      >
        <section>Balances</section>
      </ErpPage>
    );

    const page = screen.getByTestId("erp-page");
    expect(page).toHaveAttribute("data-erp-page");
    expect(page.className).toContain("space-y-6");
    expect(page).toHaveTextContent("Balances");
    expect(screen.getByRole("heading", { name: "Opening Stock" })).toBeInTheDocument();
    expect(screen.getByText("Company")).toBeInTheDocument();
    expect(screen.getByText("Current period")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" }).closest("header")).toBeInTheDocument();
  });

  it("supports the existing core ERP layout and custom root attributes", () => {
    render(
      <ErpPage title="Stock" layout="core-erp" className="custom-class" aria-label="ERP stock screen">
        <div>Stock content</div>
      </ErpPage>
    );
    const page = screen.getByLabelText("ERP stock screen");
    expect(page.className).toContain("gap-4");
    expect(page.className).toContain("custom-class");
    expect(screen.getByText("Stock content")).toBeInTheDocument();
  });
});
