import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./erpDisplay", () => ({
  useErpDateFormat: () => ({
    formatDisplayDate: (value: string) => value.replaceAll("-", "/"),
    formatDisplayDateTime: () => "09/11/2026, 12:30",
  }),
}));

import { ErpReportPrintFooter } from "./ErpReportPrintFooter";

describe("ERP print report footer", () => {
  it("identifies the company, selected period, and generated date", () => {
    const { container } = render(
      <ErpReportPrintFooter
        title="Stock and Sales"
        companyName="ERP Company"
        fromDate="2026-11-01"
        toDate="2026-11-09"
      />,
    );
    const footer = container.querySelector("[data-erp-print-footer]");
    expect(footer).toHaveTextContent("Stock and Sales");
    expect(footer).toHaveTextContent("ERP Company");
    expect(footer).toHaveTextContent("2026/11/01 – 2026/11/09");
    expect(footer).toHaveTextContent("09/11/2026, 12:30");
    expect(footer).toHaveClass("print:block");
  });

  it("handles a report without a selected period", () => {
    const { container } = render(<ErpReportPrintFooter title="Account Summary" />);
    expect(container.querySelector("[data-erp-print-footer]")).toHaveTextContent("All dates");
  });
});
