import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErpMobileRecordCard, ErpMobileRecordList, ErpMobileSummaryGrid } from "./erp-mobile-records";

vi.mock("@/contexts/ApplicationLanguageContext", () => ({
  useApplicationLanguage: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

describe("ErpMobileRecordCard", () => {
  it("renders title, value and fields, and opens the record on tap", () => {
    const onOpen = vi.fn();
    render(
      <ErpMobileRecordList>
        <ErpMobileRecordCard
          title="JV-12"
          subtitle="12 Jan 2026"
          value="$ 1,200"
          fields={[{ label: "Account", value: "Cash" }]}
          onOpen={onOpen}
          openLabel="Open JV-12"
          data-testid="card"
        />
      </ErpMobileRecordList>
    );
    expect(screen.getByTestId("card")).toHaveTextContent("JV-12");
    expect(screen.getByText("Cash")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open JV-12" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("keeps secondary details collapsed until requested", () => {
    render(
      <ErpMobileRecordList>
        <ErpMobileRecordCard title="Item" details={[{ label: "Stock", value: "42" }]} />
      </ErpMobileRecordList>
    );
    expect(screen.queryByText("42")).toBeNull();
    const toggle = screen.getByRole("button", { name: "mobileRecords.showDetails" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("shows the empty state instead of an empty list", () => {
    render(<ErpMobileRecordList isEmpty empty="Nothing here" />);
    expect(screen.getByRole("status")).toHaveTextContent("Nothing here");
  });
});

describe("ErpMobileSummaryGrid", () => {
  it("renders label/value pairs", () => {
    render(
      <ErpMobileSummaryGrid
        items={[
          { label: "Debit", value: "10" },
          { label: "Credit", value: "5" },
        ]}
      />
    );
    expect(screen.getByText("Debit")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
  });
});
