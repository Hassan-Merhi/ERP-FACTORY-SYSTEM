import { createRef, useRef, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InventoryPicker } from "@/pages/pos/pos-components/InventoryPicker";
import { usePosKeyboardNavigation } from "@/pages/pos/hooks/usePosKeyboardNavigation";
import { usePosRowCalculations } from "@/pages/pos/hooks/usePosRowCalculations";
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

const ladiesStock: InventoryItem[] = [
  { stockItemId: 101, code: "EG12394", name: "EG Ladies Tergal Pant 40 KGS", stock: 0, price: 5, configuredPrice: 5 },
  { stockItemId: 102, code: "EG12434", name: "EG Ladies Under Wear #1 40 KGS", stock: 1, price: 7, configuredPrice: 7 },
  { stockItemId: 103, code: "EG13594", name: "EG Ladies Winter Arabic Dress", stock: 15, price: 9, configuredPrice: 9 },
];

function ActualSaleSelectionHarness() {
  const [term, setTerm] = useState("");
  const [rows, setRows] = useState<SaleRow[]>([
    { id: "1", itemName: "", quantity: 0, rate: 0, rateUSD: 0, amount: 0 },
  ]);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [selectedCell, setSelectedCell] = useState({ row: 0, col: 0 });
  const [stockWarning, setStockWarning] = useState(false);
  const [, setStockName] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const { selectItem } = usePosRowCalculations({
    rows,
    activeRow: 0,
    setRows,
    setSearchTerm: setTerm,
    setZeroStockItem: setStockName,
    setZeroStockAlert: setStockWarning,
    lastSoldPrices: {},
    activeCurrency: "USD",
    exchangeRate: 1,
    focusCell: () => {},
  });
  const nav = usePosKeyboardNavigation({
    rows,
    activeRow: 0,
    highlightedIndex,
    inventory: ladiesStock,
    canSellNegativeStock: false,
    setSelectedCell,
    setHighlightedIndex,
    setRows,
    toast: () => {},
    focusCell: () => {},
    selectItem,
  });
  return (
    <>
      <input
        aria-label="Sale item"
        data-testid="actual-sale-item-input"
        value={term}
        onChange={(event) => {
          const value = event.target.value;
          setTerm(value);
          setHighlightedIndex(0);
          setRows((previous) => [{ ...previous[0], itemName: value, stockItemId: undefined }]);
        }}
        onKeyDown={(event) => nav.makeHandleKeyDown(term)(event, selectedCell.row, 0)}
      />
      <InventoryPicker
        inventory={ladiesStock}
        itemListRef={listRef}
        highlightedIndex={highlightedIndex}
        setHighlightedIndex={setHighlightedIndex}
        syncTerm={term}
        onSearchTermChange={setTerm}
        selectItem={(item) => selectItem(item, 0)}
      />
      <output data-testid="sale-selected-name">{rows[0].itemName}</output>
      <output data-testid="sale-selected-stock">{rows[0].stockItemId ?? ""}</output>
      <output data-testid="sale-selected-quantity">{rows[0].quantity}</output>
      <output data-testid="sale-selected-rate">{rows[0].rate}</output>
      <output data-testid="sale-line-count">{rows.length}</output>
      <output data-testid="sale-stock-alert">{stockWarning ? "blocked" : "clear"}</output>
    </>
  );
}

describe("POS typed sale-row item highlight and Enter-to-add", () => {
  it("defaults to a visibly selected available product instead of the first Out item", () => {
    render(<ActualSaleSelectionHarness />);
    const input = screen.getByTestId("actual-sale-item-input");
    fireEvent.change(input, { target: { value: "eg ladies" } });
    const options = screen.getAllByRole("option");
    expect(options[0].textContent).toContain("Tergal Pant");
    expect(options[0].getAttribute("aria-selected")).toBe("false");
    expect(options[1].getAttribute("aria-selected")).toBe("true");
    expect(options[1].getAttribute("data-pos-keyboard-selected")).toBe("true");
    expect(options[1].className).toContain("bg-blue-100");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("sale-selected-stock").textContent).toBe("102");
    expect(screen.getByTestId("sale-selected-name").textContent).toContain("Under Wear");
    expect(screen.getByTestId("sale-selected-quantity").textContent).toBe("1");
    expect(screen.getByTestId("sale-selected-rate").textContent).toBe("7");
    expect(screen.getByTestId("sale-line-count").textContent).toBe("2");
    expect(screen.getByTestId("sale-stock-alert").textContent).toBe("clear");
    expect((screen.getByTestId("input-product-search") as HTMLInputElement).value).toBe("");
  });

  it("ArrowDown skips sold-out items and Enter inserts the exact highlighted product", () => {
    render(<ActualSaleSelectionHarness />);
    const input = screen.getByTestId("actual-sale-item-input");
    fireEvent.change(input, { target: { value: "eg ladies" } });
    const options = screen.getAllByRole("option");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(options[2].getAttribute("aria-selected")).toBe("true");
    expect(options[2].className).toContain("bg-blue-100");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("sale-selected-stock").textContent).toBe("103");
    expect(screen.getByTestId("sale-selected-name").textContent).toContain("Winter Arabic");
    expect(screen.getByTestId("sale-selected-rate").textContent).toBe("9");
  });

  it("still allows picking an Out item from the keyboard when negative-stock sale is permitted", () => {
    const selectItem = vi.fn(() => true);
    function PermissionHarness() {
      const [highlightedIndex, setHighlightedIndex] = useState(0);
      const [term, setTerm] = useState("eg ladies");
      const listRef = useRef<HTMLDivElement>(null);
      return (
        <InventoryPicker
          inventory={ladiesStock}
          itemListRef={listRef}
          highlightedIndex={highlightedIndex}
          setHighlightedIndex={setHighlightedIndex}
          syncTerm={term}
          onSearchTermChange={setTerm}
          canSellNegativeStock
          selectItem={selectItem}
        />
      );
    }
    render(<PermissionHarness />);
    expect(screen.getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(screen.getByTestId("input-product-search"), { key: "Enter" });
    expect(selectItem).toHaveBeenCalledWith(expect.objectContaining({ stockItemId: 101 }));
  });

  it("keeps the stock warning for searches where every result is sold out", () => {
    const selectItem = vi.fn(() => false);
    function SoldOutHarness() {
      const [highlightedIndex, setHighlightedIndex] = useState(0);
      const listRef = useRef<HTMLDivElement>(null);
      return (
        <InventoryPicker
          inventory={[ladiesStock[0]]}
          itemListRef={listRef}
          highlightedIndex={highlightedIndex}
          setHighlightedIndex={setHighlightedIndex}
          selectItem={selectItem}
          syncTerm="tergal"
        />
      );
    }
    render(<SoldOutHarness />);
    expect(screen.getByRole("option").getAttribute("aria-selected")).toBe("false");
    fireEvent.keyDown(screen.getByTestId("input-product-search"), { key: "Enter" });
    expect(selectItem).toHaveBeenCalledWith(expect.objectContaining({ stockItemId: 101 }));
    expect((screen.getByTestId("input-product-search") as HTMLInputElement).value).toBe("tergal");
  });
});
