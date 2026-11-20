import React, { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  RetailPaymentAccountPicker,
  type RetailPaymentAccounts,
} from "@/pages/pos/RetailPaymentAccountSelect";

const accounts: RetailPaymentAccounts = {
  ledgers: [{ id: 7, code: "1000", name: "Café Account", accountType: "Cash" }],
  banks: [{ id: 7, code: "B-7", name: "Café Account" }],
};

function AccountHarness({ credit = false }: { credit?: boolean }) {
  const [value, setValue] = useState("");
  return (
    <>
      <RetailPaymentAccountPicker
        accounts={accounts}
        value={value}
        onValueChange={setValue}
        allowCredit={credit}
        customerName="Test Customer"
        id="retail-payment-account"
        testId="retail-payment-account"
      />
      <output data-testid="retail-payment-id">{value}</output>
    </>
  );
}

describe("Phase 4 retail account selection", () => {
  it("searches names only while preserving distinct ledger and bank IDs", () => {
    render(<AccountHarness />);
    fireEvent.click(screen.getByTestId("retail-payment-account"));
    const input = screen.getByPlaceholderText("Search account name...");
    fireEvent.change(input, { target: { value: "cafe" } });
    const rows = screen.getAllByRole("option", { name: "Café Account" });
    expect(rows).toHaveLength(2);
    expect(screen.queryByText("1000")).toBeNull();
    expect(screen.queryByText("B-7")).toBeNull();
    expect(screen.queryByText("Cash")).toBeNull();
    fireEvent.click(rows[1]);
    expect(screen.getByTestId("retail-payment-id").textContent).toBe("bank:7");
    expect(screen.getByTestId("retail-payment-account").textContent).toContain("Café Account");
  });

  it("offers customer credit only when explicitly allowed", () => {
    const { unmount } = render(<AccountHarness />);
    fireEvent.click(screen.getByTestId("retail-payment-account"));
    expect(screen.queryByRole("option", { name: /customer credit/i })).toBeNull();
    unmount();

    render(<AccountHarness credit />);
    fireEvent.click(screen.getByTestId("retail-payment-account"));
    fireEvent.click(screen.getByRole("option", { name: /customer credit/i }));
    expect(screen.getByTestId("retail-payment-id").textContent).toBe("credit");
  });
});
