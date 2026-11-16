import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ExportButton, ReportExportMenu } from "./ReportExportMenu";

describe("report export menu", () => {
  const options = [{ id: "summary", label: "Excel Summary", kind: "excel" as const, onSelect: vi.fn() }];

  it("disables empty and caller-restricted export menus", () => {
    const { rerender } = render(<ReportExportMenu options={[]} data-testid="export-test" />);
    expect(screen.getByTestId("export-test")).toBeDisabled();
    rerender(<ReportExportMenu options={options} disabled data-testid="export-test" />);
    expect(screen.getByTestId("export-test")).toBeDisabled();
  });

  it("preserves busy feedback, size, and existing export trigger IDs", () => {
    const { rerender } = render(
      <ReportExportMenu options={options} busy size="sm" data-testid="button-export-dropdown" />
    );
    const trigger = screen.getByTestId("button-export-dropdown");
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute("aria-busy", "true");
    expect(trigger).toHaveTextContent("Exporting");

    rerender(<ReportExportMenu options={options} data-testid="button-export-dropdown" />);
    expect(screen.getByTestId("button-export-dropdown")).toBeEnabled();
    expect(screen.getByTestId("button-export-dropdown")).toHaveTextContent("Export");
  });

  it("gives a single export action the standard label, icon slot and busy state", () => {
    const onClick = vi.fn();
    const { rerender } = render(<ExportButton onClick={onClick} data-testid="button-export" />);
    const button = screen.getByTestId("button-export");
    expect(button).toHaveTextContent("Export Excel");
    button.click();
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(<ExportButton kind="print" data-testid="button-export" />);
    expect(screen.getByTestId("button-export")).toHaveTextContent("Print");

    rerender(<ExportButton kind="csv" label="Export Cost CSV" busy data-testid="button-export" />);
    expect(screen.getByTestId("button-export")).toBeDisabled();
    expect(screen.getByTestId("button-export")).toHaveTextContent("Exporting");
  });
});
