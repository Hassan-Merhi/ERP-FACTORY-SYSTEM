import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Book, Receipt } from "lucide-react";
import { VoucherPhoneActionBar } from "./VoucherPhoneActionBar";
import { VoucherMobileTabs } from "./VoucherTabNav";

let phone = true;
vi.mock("@/hooks/use-erp-phone-layout", () => ({ useErpPhoneLayout: () => phone }));

afterEach(() => {
  cleanup();
  phone = true;
});

describe("VoucherPhoneActionBar", () => {
  it("shows totals, validation and Cancel | Save on phones", () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    render(
      <VoucherPhoneActionBar
        summary="Dr $10 · Cr $5"
        status={{ ok: false, label: "Off by $5" }}
        saveLabel="Save Journal Voucher"
        disabled
        onSave={onSave}
        onCancel={onCancel}
      />
    );
    expect(screen.getByText("Dr $10 · Cr $5")).toBeInTheDocument();
    expect(screen.getByTestId("voucher-phone-action-bar-status")).toHaveTextContent("Off by $5");
    expect(screen.getByTestId("voucher-phone-action-bar-save")).toBeDisabled();
    fireEvent.click(screen.getByTestId("voucher-phone-action-bar-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("submits the enclosing form when no save handler is given", () => {
    const onSubmit = vi.fn((event: Event) => event.preventDefault());
    render(
      <form onSubmit={(event) => onSubmit(event.nativeEvent)}>
        <VoucherPhoneActionBar summary="1 item" saveLabel="Save Transfer" />
      </form>
    );
    expect(screen.queryByTestId("voucher-phone-action-bar-cancel")).toBeNull();
    fireEvent.click(screen.getByTestId("voucher-phone-action-bar-save"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("renders nothing on tablet and desktop", () => {
    phone = false;
    render(<VoucherPhoneActionBar summary="x" saveLabel="Save" />);
    expect(screen.queryByTestId("voucher-phone-action-bar")).toBeNull();
  });
});

describe("VoucherMobileTabs", () => {
  it("shows the current type and switches type from the sheet", () => {
    const setActiveTab = vi.fn();
    render(
      <VoucherMobileTabs
        visibleSidebarGroups={[
          {
            label: "Financial",
            color: "red",
            items: [
              { key: "journal", label: "Journal", icon: Book },
              { key: "receipt", label: "Receipt", icon: Receipt },
            ],
          },
        ]}
        activeTab="journal"
        setActiveTab={setActiveTab}
      />
    );
    expect(screen.getByTestId("button-voucher-type-select")).toHaveTextContent("Journal");
    fireEvent.click(screen.getByTestId("button-voucher-type-select"));
    fireEvent.click(screen.getByTestId("tab-mobile-receipt"));
    expect(setActiveTab).toHaveBeenCalledWith("receipt");
  });
});
