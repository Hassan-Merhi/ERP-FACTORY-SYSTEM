/**
 * Phone POS cart: a cashier edits a line's quantity by clearing the field and
 * typing a new number. The cart used to render only lines with quantity > 0,
 * so clearing "1" unmounted the line — and the input being typed into — and
 * left an invisible zero-quantity row behind. Found by the wave 4 mobile
 * browser E2E; pinned here with the real component and a stateful harness.
 */
import React, { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { PosMobileLayout } from "@/pages/pos/pos-components/PosMobileLayout";
import type { SaleRow } from "@/pages/pos/pos-components/posTypes";

const item = { code: "P7-ITEM", name: "Browser Item", stock: 10, price: 25, configuredPrice: 20, stockItemId: 1 };

function Harness({ onSave }: { onSave: (rows: SaleRow[]) => void }) {
  const [rows, setRows] = useState<SaleRow[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const updateRow = (index: number, field: keyof SaleRow, value: string | number) =>
    setRows((current) =>
      current.map((row, i) => {
        if (i !== index) return row;
        const next = { ...row, [field]: field === "quantity" || field === "rate" ? Number(value) || 0 : value };
        next.amount = next.quantity * next.rate;
        return next;
      })
    );
  const validRows = rows.filter((row) => row.stockItemId && row.quantity > 0);
  return (
    <PosMobileLayout
      activeLocation={{ id: 1, name: "Main" } as any}
      allLocations={[{ id: 1, name: "Main" } as any]}
      posAssignedLocations={[]}
      posSelectedLocation={null}
      setPosSelectedLocation={vi.fn()}
      setSelectedLocation={vi.fn()}
      saleDate="2026-09-23"
      setSaleDate={vi.fn()}
      paymentAccountType="cash"
      setPaymentAccountType={vi.fn()}
      paymentAccountId="1"
      setPaymentAccountId={vi.fn()}
      bankAccounts={[]}
      cashLedgerAccounts={[{ id: 1, name: "Cash" } as any]}
      isCreditSale={false}
      setIsCreditSale={vi.fn()}
      mobileCustomerComboOpen={false}
      setMobileCustomerComboOpen={vi.fn()}
      selectedCustomerId=""
      setSelectedCustomerId={vi.fn()}
      customerAccounts={[]}
      searchTerm={searchTerm}
      setSearchTerm={setSearchTerm}
      mobileSearchInputRef={React.createRef()}
      inventory={[item]}
      selectItem={(picked) =>
        setRows((current) => [
          ...current,
          {
            id: `row-${current.length}`,
            itemName: picked.name,
            stockItemCode: picked.code,
            stockItemId: picked.stockItemId,
            quantity: 1,
            rate: picked.price,
            rateUSD: picked.price,
            amount: picked.price,
          },
        ])
      }
      rows={rows}
      setRows={setRows}
      updateRow={updateRow}
      notes=""
      setNotes={vi.fn()}
      saveMutation={{ isPending: false } as any}
      hasValidItems={validRows.length > 0}
      handleSaveSale={() => onSave(validRows)}
      formatDisplayAmount={(v) => `$ ${v}`}
    />
  );
}

describe("phone POS cart", () => {
  it("keeps a line on screen while its quantity is cleared and retyped", () => {
    const onSave = vi.fn();
    render(<Harness onSave={onSave} />);

    fireEvent.change(screen.getByTestId("input-mobile-product-search"), { target: { value: "Browser" } });
    fireEvent.click(screen.getByTestId("button-mobile-select-item-1"));

    fireEvent.change(screen.getByTestId("input-mobile-qty-0"), { target: { value: "" } });
    // The line (and the input being edited) must still be there.
    expect(screen.getByTestId("input-mobile-qty-0")).toBeInTheDocument();
    expect(screen.queryByText("Search above to add items.")).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId("input-mobile-qty-0"), { target: { value: "3" } });
    expect(screen.getAllByText("1 item · Qty 3").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId("button-mobile-checkout"));
    expect(onSave).toHaveBeenCalledWith([expect.objectContaining({ stockItemId: 1, quantity: 3, amount: 75 })]);
  });

  it("does not count a zero-quantity line in the totals", () => {
    render(<Harness onSave={vi.fn()} />);
    fireEvent.change(screen.getByTestId("input-mobile-product-search"), { target: { value: "Browser" } });
    fireEvent.click(screen.getByTestId("button-mobile-select-item-1"));
    fireEvent.change(screen.getByTestId("input-mobile-qty-0"), { target: { value: "" } });

    expect(screen.getAllByText("0 items · Qty 0").length).toBeGreaterThan(0);
    expect(screen.getByTestId("button-mobile-delete-0")).toBeInTheDocument();
  });

  it("removes a line with its delete button", () => {
    render(<Harness onSave={vi.fn()} />);
    fireEvent.change(screen.getByTestId("input-mobile-product-search"), { target: { value: "Browser" } });
    fireEvent.click(screen.getByTestId("button-mobile-select-item-1"));
    fireEvent.click(screen.getByTestId("button-mobile-delete-0"));

    expect(screen.queryByTestId("input-mobile-qty-0")).not.toBeInTheDocument();
    expect(screen.getByText("Search above to add items.")).toBeInTheDocument();
  });
});
