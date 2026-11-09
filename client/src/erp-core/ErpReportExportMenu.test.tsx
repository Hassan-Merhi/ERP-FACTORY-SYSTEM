import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ErpReportExportMenu } from "./ErpReportExportMenu";

describe("ERP report export menu", () => {
  const options = [{ id: "summary", label: "Excel Summary", kind: "excel" as const, onSelect: vi.fn() }];

  it("disables empty and caller-restricted export menus", () => {
    const { rerender } = render(<ErpReportExportMenu options={[]} data-testid="export-test" />);
    expect(screen.getByTestId("export-test")).toBeDisabled();
    rerender(<ErpReportExportMenu options={options} disabled data-testid="export-test" />);
    expect(screen.getByTestId("export-test")).toBeDisabled();
  });

  it("preserves busy feedback, size, and existing export trigger IDs", () => {
    const { rerender } = render(
      <ErpReportExportMenu options={options} busy size="sm" data-testid="button-export-dropdown" />
    );
    const trigger = screen.getByTestId("button-export-dropdown");
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute("aria-busy", "true");
    expect(trigger).toHaveTextContent("Exporting");

    rerender(<ErpReportExportMenu options={options} data-testid="button-export-dropdown" />);
    expect(screen.getByTestId("button-export-dropdown")).toBeEnabled();
    expect(screen.getByTestId("button-export-dropdown")).toHaveTextContent("Export");
  });
});
