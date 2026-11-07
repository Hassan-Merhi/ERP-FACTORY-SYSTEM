import { createRef, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InventoryPicker } from "@/pages/pos/pos-components/InventoryPicker";
import type { InventoryItem } from "@/pages/pos/pos-components/posTypes";

vi.mock("@/components/MobileBarcodeScanner", () => ({
  MobileBarcodeScanner: () => null,
}));

const stock: InventoryItem[] = [
  { stockItemId: 2, code: "SH-2", name: "Blue shirt", stock: 12, price: 5, configuredPrice: 5 },
  { stockItemId: 10, code: "SH-10", name: "Green shirt", stock: 8, price: 6, configuredPrice: 6 },
  { stockItemId: 1, code: "SH-1", name: "Red shirt", stock: 11, price: 7, configuredPrice: 7 },
];

function PickerHarness({ onSelect }: { onSelect: (item: InventoryItem) => void }) {
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  return (
    <InventoryPicker
      inventory={stock}
      selectItem={onSelect}
      itemListRef={createRef<HTMLDivElement>()}
      highlightedIndex={highlightedIndex}
      setHighlightedIndex={setHighlightedIndex}
    />
  );
}

afterEach(cleanup);

describe("POS inventory sidebar search keyboard", () => {
  it("supports arrow navigation and Enter against the exact visible filtered order", () => {
    const onSelect = vi.fn();
    render(<PickerHarness onSelect={onSelect} />);
    const input = screen.getByTestId("input-product-search");
    fireEvent.change(input, { target: { value: "shirt" } });
    const items = screen.getAllByRole("option");
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain("Red shirt");
    expect(items[1].textContent).toContain("Blue shirt");
    expect(input.getAttribute("aria-activedescendant")).toBe(items[0].id);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(items[1].id);
    expect(items[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ stockItemId: 2 }));
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("clamps ArrowUp at the first match and resets selection after search changes", () => {
    render(<PickerHarness onSelect={vi.fn()} />);
    const input = screen.getByTestId("input-product-search");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.change(input, { target: { value: "green" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "Escape" });
    expect((input as HTMLInputElement).value).toBe("");
  });
});
