import React, { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SearchField } from "@/components/ui/search-field";

function ControlledSearch({ clearOnEscape = false }: { clearOnEscape?: boolean }) {
  const [value, setValue] = useState("");
  return (
    <SearchField
      aria-label="Find records"
      placeholder="Search records..."
      value={value}
      onValueChange={setValue}
      clearOnEscape={clearOnEscape}
      data-testid="input-unified-search"
    />
  );
}

describe("Phase 1 unified SearchField", () => {
  it("is a controlled, accessible searchbox with responsive touch sizing", () => {
    render(<ControlledSearch />);
    const input = screen.getByRole("searchbox", { name: "Find records" }) as HTMLInputElement;
    expect(input.type).toBe("search");
    expect(input.className).toContain("min-h-11");
    fireEvent.change(input, { target: { value: "Café-123" } });
    expect(input.value).toBe("Café-123");
  });

  it("has one clear action that restores focus to the input", () => {
    render(<ControlledSearch />);
    const input = screen.getByRole("searchbox", { name: "Find records" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "invoice" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
  });

  it("clears with Escape only when the owner opts in", () => {
    const first = render(<ControlledSearch />);
    const defaultInput = screen.getByRole("searchbox", { name: "Find records" }) as HTMLInputElement;
    fireEvent.change(defaultInput, { target: { value: "kept" } });
    fireEvent.keyDown(defaultInput, { key: "Escape" });
    expect(defaultInput.value).toBe("kept");
    first.unmount();

    render(<ControlledSearch clearOnEscape />);
    const input = screen.getByRole("searchbox", { name: "Find records" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "clear me" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
  });

  it("supports busy lookup state without accepting edits", () => {
    const onValueChange = vi.fn();
    render(
      <SearchField
        value="pending"
        onValueChange={onValueChange}
        loading
        aria-label="Search accounts"
        data-testid="input-loading-search"
      />
    );
    const input = screen.getByRole("searchbox", { name: "Search accounts" }) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.getAttribute("aria-busy")).toBe("true");
    expect((screen.getByRole("button", { name: "Clear search" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "new search" } });
    expect(onValueChange).not.toHaveBeenCalled();
  });
});
