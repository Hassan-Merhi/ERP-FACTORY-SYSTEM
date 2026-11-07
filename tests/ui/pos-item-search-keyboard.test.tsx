import { createRef, useRef, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InventoryPicker } from "@/pages/pos/pos-components/InventoryPicker";
import { usePosKeyboardNavigation } from "@/pages/pos/hooks/usePosKeyboardNavigation";
import type { SaleRow } from "@/pages/pos/pos-components/posTypes";
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


function GridToSidebarHarness({
  onSelect,
  onToast,
}: {
  onSelect: (item: InventoryItem) => void;
  onToast: (options: { title: string }) => void;
}) {
  const [term, setTerm] = useState("");
  const [rows, setRows] = useState<SaleRow[]>([
    { id: "1", itemName: "", quantity: 0, rate: 0, rateUSD: 0, amount: 0 },
  ]);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [selectedCell, setSelectedCell] = useState({ row: 0, col: 0 });
  const sidebarSearch = useRef<HTMLInputElement>(null);
  const itemListRef = useRef<HTMLDivElement>(null);
  const nav = usePosKeyboardNavigation({
    rows,
    activeRow: 0,
    highlightedIndex,
    inventory: stock,
    setSelectedCell,
    setHighlightedIndex,
    setRows,
    toast: onToast,
    focusCell: () => {},
    focusInventoryPicker: () => sidebarSearch.current?.focus(),
    selectItem: onSelect,
  });
  return (
    <>
      <input
        aria-label="Item"
        data-testid="input-grid-item"
        value={term}
        onChange={(event) => {
          const next = event.target.value;
          setTerm(next);
          setHighlightedIndex(0);
          setRows((prev) => [{ ...prev[0], itemName: next, stockItemId: undefined }]);
        }}
        onKeyDown={(event) => nav.makeHandleKeyDown(term)(event, selectedCell.row, 0)}
      />
      <InventoryPicker
        inventory={stock}
        itemListRef={itemListRef}
        highlightedIndex={highlightedIndex}
        setHighlightedIndex={setHighlightedIndex}
        syncTerm={term}
        onSearchTermChange={setTerm}
        searchInputRef={sidebarSearch}
        listId="pos-desktop-item-options"
        selectItem={onSelect}
      />
    </>
  );
}

describe("POS sale-row keyboard and sidebar pointer integration", () => {
  it("moves through the visible sidebar options while typing in the sale row", () => {
    const onSelect = vi.fn();
    const onToast = vi.fn();
    render(<GridToSidebarHarness onSelect={onSelect} onToast={onToast} />);
    const grid = screen.getByTestId("input-grid-item");
    fireEvent.change(grid, { target: { value: "shirt" } });
    expect((screen.getByTestId("input-product-search") as HTMLInputElement).value).toBe("shirt");
    const options = screen.getAllByRole("option");
    expect(options[0].textContent).toContain("Red shirt");
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(options[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(grid, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ code: "SH-2" }));
    expect(onToast).not.toHaveBeenCalled();
  });

  it("scrolls the Items list to the highlighted result while the sale-row input stays focused", () => {
    render(<GridToSidebarHarness onSelect={vi.fn()} onToast={vi.fn()} />);
    const grid = screen.getByTestId("input-grid-item");
    fireEvent.change(grid, { target: { value: "shirt" } });
    grid.focus();

    const list = screen.getByRole("listbox");
    const options = screen.getAllByRole("option");
    // Give jsdom a small scroll viewport and real option positions; the old
    // tests checked aria-selected only and missed the actual scrollbar.
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 60 } as DOMRect);
    options.forEach((option, index) => {
      vi.spyOn(option, "getBoundingClientRect").mockReturnValue({
        top: index * 50,
        bottom: (index + 1) * 50,
      } as DOMRect);
    });

    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(options[1].getAttribute("aria-selected")).toBe("true");
    expect(list.scrollTop).toBe(40);
    expect(document.activeElement).toBe(grid);
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(options[2].getAttribute("aria-selected")).toBe("true");
    expect(list.scrollTop).toBeGreaterThan(40);
  });

  it("does not let stationary mouse hover reset an arrow-key selection", () => {
    render(<GridToSidebarHarness onSelect={vi.fn()} onToast={vi.fn()} />);
    const grid = screen.getByTestId("input-grid-item");
    fireEvent.change(grid, { target: { value: "shirt" } });
    const options = screen.getAllByRole("option");

    fireEvent.mouseMove(options[0], { clientX: 25, clientY: 40 });
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(options[1].getAttribute("aria-selected")).toBe("true");
    // Browsers can fire a fresh mouseenter after scrolling an item under a
    // stationary cursor. Only real pointer movement should change selection.
    fireEvent.mouseEnter(options[0], { clientX: 25, clientY: 40 });
    expect(options[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.mouseMove(options[0], { clientX: 26, clientY: 40 });
    expect(options[0].getAttribute("aria-selected")).toBe("true");
  });

  it("moves focus to the sidebar with Right Arrow without an Invalid item warning", () => {
    const onSelect = vi.fn();
    const onToast = vi.fn();
    render(<GridToSidebarHarness onSelect={onSelect} onToast={onToast} />);
    const grid = screen.getByTestId("input-grid-item");
    fireEvent.change(grid, { target: { value: "shirt" } });
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByTestId("input-product-search"));
    expect(onToast).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ code: "SH-2" }));
  });

  it("supports mouse hover and click after searching from the sale row", () => {
    const onSelect = vi.fn();
    render(<GridToSidebarHarness onSelect={onSelect} onToast={vi.fn()} />);
    fireEvent.change(screen.getByTestId("input-grid-item"), { target: { value: "shirt" } });
    const options = screen.getAllByRole("option");
    fireEvent.mouseMove(options[2], { clientX: 25, clientY: 40 });
    expect(options[2].getAttribute("aria-selected")).toBe("true");
    fireEvent.click(options[2]);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ code: "SH-10" }));
    expect((screen.getByTestId("input-product-search") as HTMLInputElement).value).toBe("");
  });

  it("preserves the search after a stock-rule rejection", () => {
    const onSelect = vi.fn(() => false);
    render(
      <InventoryPicker
        inventory={stock}
        selectItem={onSelect}
        itemListRef={createRef<HTMLDivElement>()}
        highlightedIndex={0}
        setHighlightedIndex={vi.fn()}
      />
    );
    const input = screen.getByTestId("input-product-search");
    fireEvent.change(input, { target: { value: "shirt" } });
    fireEvent.click(screen.getAllByRole("option")[0]);
    expect((input as HTMLInputElement).value).toBe("shirt");
  });
});
