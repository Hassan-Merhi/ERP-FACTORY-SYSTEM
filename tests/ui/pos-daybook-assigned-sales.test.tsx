import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { POSDaybookDaybookResultsSection } from "@/pages/pos/POSDaybookDaybookResultsSection";

vi.mock("@/components/daybook/DaybookFrame", () => ({
  DaybookResults: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DaybookShowHiddenButton: () => null,
  DaybookTableState: () => null,
}));
vi.mock("@/components/PaginationBar", () => ({ PaginationBar: () => null }));
vi.mock("@/erp-core", () => ({
  ErpListTable: ({ children }: { children: React.ReactNode }) => <table>{children}</table>,
}));

describe("POS Daybook assigned-location receipt actions", () => {
  it("opens another cashier's sale and transfers without granting receipt resend rights", () => {
    const sale = {
      id: 21,
      voucherNumber: "SV-21",
      voucherType: "Sales",
      voucherDate: "2026-11-18",
      createdAt: "2026-11-18T09:00:00Z",
      userId: "another-cashier",
      locationId: 3,
      locationName: "LUSAKA DEPOT",
      totalAmount: "300.00",
      description: "POS sale",
    };
    const transfer = {
      ...sale,
      id: 22,
      voucherNumber: "TRANSFER-22",
      voucherType: "Stock Transfer",
      totalAmount: "0",
    };
    const setSelectedVoucher = vi.fn();
    const setPrintVoucherId = vi.fn();
    const resend = vi.fn();
    render(
      <POSDaybookDaybookResultsSection
        {...({
          currentUser: { id: "cashier-a", role: "POS" },
          error: null,
          formatCashAmount: (value: number) => `$${value.toFixed(2)}`,
          hiddenRowIds: new Set<number>(),
          isError: false,
          isLoading: false,
          isLoadingUser: false,
          isPOS: true,
          navigate: vi.fn(),
          pagination: {
            page: 1,
            totalPages: 1,
            pageSize: 100,
            paginate: (rows: unknown[]) => rows,
            setPage: vi.fn(),
          },
          printVoucherId: null,
          recordChanges: { allowed: true },
          refetch: vi.fn(),
          searchedVouchers: [sale, transfer],
          setFilter: vi.fn(),
          setHiddenRowIds: vi.fn(),
          setPrintVoucherId,
          setSelectedVoucher,
          showHidden: false,
          showState: false,
          visibleVouchers: [sale, transfer],
          whatsappMutation: { isPending: false, mutate: resend },
        } as any)}
      />
    );

    const saleView = screen.getByRole("button", { name: "View SV-21" });
    expect(saleView).toBeEnabled();
    fireEvent.click(saleView);
    expect(setSelectedVoucher).toHaveBeenCalledWith(sale);

    const transferView = screen.getByRole("button", { name: "View TRANSFER-22" });
    expect(transferView).toBeEnabled();
    fireEvent.click(transferView);
    expect(setSelectedVoucher).toHaveBeenCalledWith(transfer);

    const print = screen.getByRole("button", { name: "Print receipt SV-21" });
    expect(print).toBeEnabled();
    fireEvent.click(print);
    expect(setPrintVoucherId).toHaveBeenCalledWith(21);

    const resendButton = screen.getByRole("button", { name: "Resend SV-21 on WhatsApp" });
    expect(resendButton).toBeDisabled();
    fireEvent.click(resendButton);
    expect(resend).not.toHaveBeenCalled();
  });
});
