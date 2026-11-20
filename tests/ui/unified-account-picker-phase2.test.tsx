import React, { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  UnifiedAccountPicker,
  filterAccountPickerChoices,
  type AccountPickerChoice,
} from "@/components/accounts/UnifiedAccountPicker";

const choices: AccountPickerChoice[] = [
  { value: "ledger:1", name: "Café Rent Expense" },
  { value: "bank:1", name: "Café Rent Expense" },
  { value: "ledger:2", name: "Sales Revenue" },
];

function SingleHarness() {
  const [value, setValue] = useState("");
  return (
    <>
      <UnifiedAccountPicker
        options={choices}
        value={value}
        onChange={setValue}
        placeholder="Select account"
        testId="unified-account"
        optionTestId={(key) => `option-${key}`}
        allowClear
      />
      <output data-testid="selected-account">{value}</output>
    </>
  );
}

function MultiHarness() {
  const [selectedValues, setSelectedValues] = useState<string[]>([]);
  return (
    <>
      <UnifiedAccountPicker
        mode="multiple"
        options={choices}
        selectedValues={selectedValues}
        onSelectedValuesChange={setSelectedValues}
        testId="multi-accounts"
      />
      <output data-testid="multi-values">{selectedValues.join(",")}</output>
    </>
  );
}

describe("Phase 2 unified account picker", () => {
  it("filters account names without matching internal code, type or key", () => {
    expect(filterAccountPickerChoices(choices, "cafe rent").map((a) => a.value)).toEqual([
      "ledger:1",
      "bank:1",
    ]);
    expect(filterAccountPickerChoices(choices, "ledger")).toEqual([]);
    expect(filterAccountPickerChoices(choices, "bank:1")).toEqual([]);
    expect(filterAccountPickerChoices(choices, "revenue").map((a) => a.value)).toEqual(["ledger:2"]);
  });

  it("keeps distinct IDs for duplicate account names and displays names only", () => {
    render(<SingleHarness />);
    fireEvent.click(screen.getByTestId("unified-account"));
    expect(screen.getAllByText("Café Rent Expense").length).toBe(2);
    expect(screen.queryByText("ledger:1")).toBeNull();
    fireEvent.click(screen.getByTestId("option-bank:1"));
    expect(screen.getByTestId("selected-account").textContent).toBe("bank:1");
    expect(screen.getByTestId("unified-account").textContent).toContain("Café Rent Expense");
    expect(screen.getByTestId("unified-account").textContent).not.toContain("bank");
  });

  it("can search by normalized account name and clear the single selection", () => {
    render(<SingleHarness />);
    fireEvent.click(screen.getByTestId("unified-account"));
    fireEvent.change(screen.getByPlaceholderText("Search account name..."), {
      target: { value: "sales-revenue" },
    });
    expect(screen.queryByTestId("option-ledger:1")).toBeNull();
    fireEvent.click(screen.getByTestId("option-ledger:2"));
    expect(screen.getByTestId("selected-account").textContent).toBe("ledger:2");
    fireEvent.click(screen.getByTestId("unified-account"));
    fireEvent.click(screen.getByRole("button", { name: "Clear account" }));
    expect(screen.getByTestId("selected-account").textContent).toBe("");
  });

  it("supports independent multi-selection and clear-all without confusing IDs", () => {
    render(<MultiHarness />);
    fireEvent.click(screen.getByTestId("multi-accounts"));
    fireEvent.click(screen.getByText("Sales Revenue"));
    expect(screen.getByTestId("multi-values").textContent).toBe("ledger:2");
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.getByTestId("multi-values").textContent).toBe("");
  });

  it("respects disabled state without modifying the controlled selection", () => {
    const onChange = vi.fn();
    render(
      <UnifiedAccountPicker options={choices} value="ledger:1" onChange={onChange} disabled testId="disabled-account" />
    );
    expect(screen.getByTestId("disabled-account")).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });
});
