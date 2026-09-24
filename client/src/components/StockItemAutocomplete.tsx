import { useState, useRef, useEffect, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { searchAny } from "@shared/searchNormalization";

interface StockItem {
  id: number;
  name: string;
  code?: string;
}

interface StockItemAutocompleteProps {
  value: { id: number; name: string } | null;
  onChange: (stockItemId: number, stockItemName: string) => void;
  stockItems: StockItem[];
  onFocus?: () => void;
  onArrowUp?: () => void;
  onArrowDown?: () => void;
  onArrowLeft?: () => void;
  onArrowRight?: () => void;
  onTab?: () => void;
  onEnter?: () => void;
  onSearchChange?: (searchTerm: string) => void;
  rowIndex?: number;
  placeholder?: string;
  testId?: string;
  hideDropdown?: boolean;
}

export function StockItemAutocomplete({
  value,
  onChange,
  stockItems,
  onFocus,
  onArrowUp,
  onArrowDown,
  onArrowLeft,
  onArrowRight,
  onTab,
  onEnter,
  onSearchChange,
  placeholder = "Type item name...",
  testId,
  hideDropdown = false,
}: StockItemAutocompleteProps) {
  const [searchTerm, setSearchTerm] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelPendingBlur = useCallback(() => {
    if (blurTimerRef.current !== null) {
      clearTimeout(blurTimerRef.current);
      blurTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => cancelPendingBlur();
  }, [cancelPendingBlur]);

  const displayValue = searchTerm !== null ? searchTerm : value ? value.name : "";

  const sortedItems = [...stockItems].sort((a, b) => a.name.localeCompare(b.name));

  const filteredItems =
    searchTerm !== null && searchTerm.length > 0
      ? sortedItems.filter((item) => searchAny(searchTerm, item.name, item.code))
      : sortedItems;

  useEffect(() => {
    setSelectedIndex((previous) => {
      if (filteredItems.length === 0) return 0;
      return Math.min(previous, filteredItems.length - 1);
    });
  }, [filteredItems.length]);

  const handleSelect = (item: StockItem) => {
    cancelPendingBlur();
    onChange(item.id, item.name);
    setSearchTerm(null);
    setIsOpen(false);
    setSelectedIndex(0);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      if (isOpen && filteredItems.length > 0) {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, filteredItems.length - 1));
      } else if (!isOpen && onArrowDown) {
        e.preventDefault();
        onArrowDown();
      }
    } else if (e.key === "ArrowUp") {
      if (isOpen && filteredItems.length > 0) {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
      } else if (!isOpen && onArrowUp) {
        e.preventDefault();
        onArrowUp();
      }
    } else if (e.key === "ArrowLeft") {
      if (!isOpen && onArrowLeft) {
        e.preventDefault();
        onArrowLeft();
      }
    } else if (e.key === "ArrowRight") {
      if (!isOpen && onArrowRight) {
        e.preventDefault();
        onArrowRight();
      }
    } else if (e.key === "Enter") {
      if (isOpen && filteredItems.length > 0) {
        e.preventDefault();
        handleSelect(filteredItems[selectedIndex]);
      } else if (onEnter) {
        e.preventDefault();
        onEnter();
      }
    } else if (e.key === "Tab") {
      if (isOpen && filteredItems.length > 0 && searchTerm !== null && searchTerm.length > 0) {
        e.preventDefault();
        handleSelect(filteredItems[selectedIndex]);
      } else if (onTab) {
        e.preventDefault();
        onTab();
      }
    } else if (e.key === "Escape") {
      cancelPendingBlur();
      setIsOpen(false);
      setSearchTerm(null);
      setSelectedIndex(0);
    }
  };

  // Keep keyboard navigation inside this dropdown. scrollIntoView can move ancestor
  // scroll containers or the whole page, which made autocomplete fields visibly jump.
  useEffect(() => {
    const dropdown = dropdownRef.current;
    if (!isOpen || !dropdown || filteredItems.length === 0) return;

    const selectedElement = dropdown.children[selectedIndex] as HTMLElement | undefined;
    if (!selectedElement) return;

    const itemTop = selectedElement.offsetTop;
    const itemBottom = itemTop + selectedElement.offsetHeight;
    const visibleTop = dropdown.scrollTop;
    const visibleBottom = visibleTop + dropdown.clientHeight;

    if (itemTop < visibleTop) {
      dropdown.scrollTop = itemTop;
    } else if (itemBottom > visibleBottom) {
      dropdown.scrollTop = itemBottom - dropdown.clientHeight;
    }
  }, [selectedIndex, isOpen, filteredItems.length]);

  return (
    <div className="relative">
      <Input
        ref={inputRef}
        type="text"
        value={displayValue}
        onChange={(e) => {
          cancelPendingBlur();
          setSearchTerm(e.target.value);
          setIsOpen(true);
          setSelectedIndex(0);
          if (onSearchChange) onSearchChange(e.target.value);
        }}
        onFocus={() => {
          cancelPendingBlur();
          setIsOpen(true);
          if (onFocus) onFocus();
        }}
        onBlur={() => {
          cancelPendingBlur();
          blurTimerRef.current = setTimeout(() => {
            blurTimerRef.current = null;
            setIsOpen(false);
            setSearchTerm(null);
            setSelectedIndex(0);
          }, 200);
        }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        data-testid={testId}
        className="w-full"
      />

      {isOpen && filteredItems.length > 0 && !hideDropdown && (
        <div
          ref={dropdownRef}
          className="absolute z-50 w-full mt-1 max-h-60 overflow-auto rounded-md border bg-popover text-popover-foreground shadow-md"
        >
          {filteredItems.map((item, index) => (
            <div
              key={item.id}
              className={cn(
                "px-3 py-2 cursor-pointer hover-elevate",
                index === selectedIndex && "bg-accent text-accent-foreground"
              )}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => handleSelect(item)}
            >
              {item.name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
