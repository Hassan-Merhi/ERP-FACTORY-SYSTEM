import React, { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  UnifiedAccountPicker,
  filterAccountPickerChoices,
  type AccountPickerChoice,
} from "@/components/accounts/UnifiedAccountPicker";

const options: AccountPickerChoice[] = [
  { value: "ledger:4", name: "Café - Rent" },
  { value: "bank:4", name: "Café - Rent" },
  { value: "ledger:5", name: "Gross Revenue" },
  { value: "ledger:6", name: "Restricted Cash", disabled: true },
];

function SelectionHarness({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState("");
  return (
    <>
      <UnifiedAccountPicker
        options={options}
        value={value}
        onChange={setValue}
        testId="phase5-account"
        optionTestId={(id) => `phase5-option-${id}`}
        ariaLabel="Posting account"
        allowClear
        disabled={disabled}
      />
      <output data-testid="phase5-selected">{value}</output>
    </>
  );
}

describe("Phase 5 searchable account picker regression coverage", () => {
  it("searches thousands of account names including names beyond the first 250", () => {
    const many: AccountPickerChoice[] = Array.from({ length: 5000 }, (_, index) => ({
      value: `ledger:${index + 1}`,
      name: `Expense ${index + 1}`,
    }));
    many.push({ value: "bank:99", name: "Último Hébergement" });
    expect(filterAccountPickerChoices(many, "ultimo-hebergement").map((entry) => entry.value)).toEqual(["bank:99"]);
    expect(filterAccountPickerChoices(many, "Expense").length).toBe(250);
    expect(filterAccountPickerChoices(many, "expense", 15).length).toBe(15);
    // IDs are opaque posting keys; they must never become searchable text.
    expect(filterAccountPickerChoices(many, "ledger:5000")).toEqual([]);
    expect(filterAccountPickerChoices(many, "bank:99")).toEqual([]);
  });

  it("keeps duplicate display names independent and never displays their posting IDs", () => {
    render(<SelectionHarness />);
    const picker = screen.getByTestId("phase5-account");
    expect(picker).toHaveAttribute("aria-label", "Posting account");
    expect(picker).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(picker);
    expect(picker).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("option", { name: "Café - Rent" })).toHaveLength(2);
    expect(screen.queryByText("ledger:4")).toBeNull();
    fireEvent.click(screen.getByTestId("phase5-option-bank:4"));
    expect(screen.getByTestId("phase5-selected").textContent).toBe("bank:4");
  });

  it("supports normalized typing and a recoverable clear without selecting by code", () => {
    render(<SelectionHarness />);
    fireEvent.click(screen.getByTestId("phase5-account"));
    const search = screen.getByPlaceholderText("Search account name...");
    fireEvent.change(search, { target: { value: "gross-revenue" } });
    expect(screen.queryByTestId("phase5-option-ledger:4")).toBeNull();
    fireEvent.click(screen.getByTestId("phase5-option-ledger:5"));
    expect(screen.getByTestId("phase5-selected").textContent).toBe("ledger:5");
    fireEvent.click(screen.getByTestId("phase5-account"));
    fireEvent.click(screen.getByRole("button", { name: "Clear account" }));
    expect(screen.getByTestId("phase5-selected").textContent).toBe("");
  });

  it("keeps restricted options disabled and read-only pickers immutable", () => {
    const onChange = vi.fn();
    const { unmount } = render(
      <UnifiedAccountPicker options={options} value="ledger:5" onChange={onChange} disabled testId="readonly-account" />
    );
    expect(screen.getByTestId("readonly-account")).toBeDisabled();
    fireEvent.click(screen.getByTestId("readonly-account"));
    expect(screen.queryByText("Restricted Cash")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    unmount();
    render(<SelectionHarness />);
    fireEvent.click(screen.getByTestId("phase5-account"));
    fireEvent.click(screen.getByTestId("phase5-option-ledger:6"));
    expect(screen.getByTestId("phase5-selected").textContent).toBe("");
  });

  it("exposes mobile-sized account buttons without a horizontal fixed-width picker", () => {
    render(<SelectionHarness />);
    const trigger = screen.getByTestId("phase5-account");
    expect(trigger.className).toContain("min-h-11");
    expect(trigger.className).toContain("w-full");
    fireEvent.click(trigger);
    expect(screen.getByPlaceholderText("Search account name...")).toBeTruthy();
    const choices = screen.getAllByRole("option");
    expect(choices.length).toBeGreaterThan(0);
  });

  it("supports closing by Escape and opening again without stale search terms", () => {
    render(<SelectionHarness />);
    const trigger = screen.getByTestId("phase5-account");
    fireEvent.click(trigger);
    const search = screen.getByPlaceholderText("Search account name...");
    fireEvent.change(search, { target: { value: "Gross" } });
    expect(screen.getByTestId("phase5-option-ledger:5")).toBeTruthy();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(screen.getAllByRole("option", { name: "Café - Rent" })).toHaveLength(2);
  });

  it("selects the highlighted account with keyboard arrows and Enter", () => {
    render(<SelectionHarness />);
    fireEvent.click(screen.getByTestId("phase5-account"));
    const search = screen.getByPlaceholderText("Search account name...");
    fireEvent.change(search, { target: { value: "Gross" } });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(screen.getByTestId("phase5-selected").textContent).toBe("ledger:5");
  });

  it("renders a historical group label without offering it as a new posting choice", () => {
    const onChange = vi.fn();
    render(
      <UnifiedAccountPicker
        options={[{ value: "ledger:3", name: "Operating Cash" }]}
        value="ledger:99"
        selectedFallbackName="Old Group Heading"
        onChange={onChange}
        testId="historical-account"
      />
    );
    expect(screen.getByTestId("historical-account").textContent).toContain("Old Group Heading");
    fireEvent.click(screen.getByTestId("historical-account"));
    expect(screen.queryByRole("option", { name: "Old Group Heading" })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: "Operating Cash" }));
    expect(onChange).toHaveBeenCalledWith("ledger:3");
  });

  it("preserves independent multi-account selections and clear-all behavior", () => {
    function Multiple() {
      const [values, setValues] = useState<string[]>([]);
      return (
        <>
          <UnifiedAccountPicker
            mode="multiple"
            options={options}
            selectedValues={values}
            onSelectedValuesChange={setValues}
            testId="phase5-multi"
          />
          <output data-testid="phase5-multi-values">{values.join("|")}</output>
        </>
      );
    }
    render(<Multiple />);
    fireEvent.click(screen.getByTestId("phase5-multi"));
    fireEvent.click(screen.getByTestId("phase5-multi-search"));
    fireEvent.click(screen.getByRole("option", { name: "Gross Revenue" }));
    expect(screen.getByTestId("phase5-multi-values").textContent).toBe("ledger:5");
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.getByTestId("phase5-multi-values").textContent).toBe("");
  });
});
