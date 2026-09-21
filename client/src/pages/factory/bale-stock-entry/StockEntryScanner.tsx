import { useEffect, useRef, useState } from "react";
import { ScanLine, AlertCircle, Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { FactoryMobileScannerPanel, FactoryMobileStatus } from "@/components/ui/factory-mobile";
import { FactoryBaleProduct } from "@shared/schema";

interface StockEntryScannerProps {
  scanRef: React.RefObject<HTMLInputElement | null>;
  scanInput: string;
  onScanInputChange: (val: string) => void;
  onScanKeyDown: (e: React.KeyboardEvent) => void;
  scanError: string;
  showDropdown: boolean;
  filteredProducts: FactoryBaleProduct[];
  onSelectProduct: (product: FactoryBaleProduct) => void;
}

export function StockEntryScanner({
  scanRef,
  scanInput,
  onScanInputChange,
  onScanKeyDown,
  scanError,
  showDropdown,
  filteredProducts,
  onSelectProduct,
}: StockEntryScannerProps) {
  const [activeIndex, setActiveIndex] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const listId = "factory-stock-entry-product-results";
  const errorId = "factory-stock-entry-scan-error";

  useEffect(() => {
    setActiveIndex(-1);
  }, [filteredProducts]);

  useEffect(() => {
    if (activeIndex >= 0 && itemRefs.current[activeIndex]) {
      itemRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const isOpen = showDropdown && filteredProducts.length > 0;

    if (isOpen && e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filteredProducts.length - 1));
      return;
    }

    if (isOpen && e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
      return;
    }

    if (isOpen && (e.key === "Enter" || e.key === "Tab")) {
      const target = activeIndex >= 0 ? filteredProducts[activeIndex] : filteredProducts[0];
      if (target) {
        e.preventDefault();
        onSelectProduct(target);
        setActiveIndex(-1);
        return;
      }
    }

    if (e.key === "Escape" && isOpen) {
      e.preventDefault();
      setActiveIndex(-1);
      return;
    }

    onScanKeyDown(e);
  };

  const isOpen = showDropdown && filteredProducts.length > 0;

  return (
    <FactoryMobileScannerPanel>
      <label htmlFor="factory-stock-entry-scan" className="mb-2 block text-sm font-medium">
        Scan article code or search product
      </label>
      <div className="relative group">
        <div className="pointer-events-none absolute inset-y-0 left-3 flex items-center">
          <ScanLine className="h-5 w-5 text-muted-foreground transition-colors group-focus-within:text-primary" />
        </div>
        <Input
          id="factory-stock-entry-scan"
          ref={scanRef as React.RefObject<HTMLInputElement>}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={isOpen}
          aria-controls={listId}
          aria-activedescendant={
            activeIndex >= 0 ? `factory-product-option-${filteredProducts[activeIndex]?.id}` : undefined
          }
          aria-invalid={Boolean(scanError)}
          aria-describedby={scanError ? errorId : undefined}
          autoComplete="off"
          autoCapitalize="none"
          enterKeyHint="done"
          placeholder="Scan code or type product name..."
          value={scanInput}
          onChange={(e) => onScanInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          className="h-12 rounded-xl border-2 pl-11 text-base shadow-sm transition-all focus-visible:ring-primary/20 sm:h-11"
          data-testid="input-scan-product"
        />

        {scanError && (
          <FactoryMobileStatus
            id={errorId}
            className="mt-2 flex items-start gap-2 border-destructive/40 bg-destructive/5 text-destructive"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 break-words">{scanError}</span>
          </FactoryMobileStatus>
        )}

        {isOpen && (
          <div
            id={listId}
            ref={listRef}
            role="listbox"
            aria-label="Matching bale products"
            className="absolute z-50 mt-1 max-h-72 w-full overflow-y-auto overscroll-contain rounded-xl border bg-background shadow-xl max-sm:relative max-sm:mt-2 max-sm:max-h-[min(20rem,45dvh)]"
          >
            {filteredProducts.map((p, idx) => (
              <button
                key={p.id}
                id={`factory-product-option-${p.id}`}
                ref={(el) => {
                  itemRefs.current[idx] = el;
                }}
                type="button"
                role="option"
                aria-selected={idx === activeIndex}
                className={`flex min-h-12 w-full cursor-pointer items-center justify-between gap-3 border-b px-3 py-3 text-left transition-colors last:border-0 sm:px-4 sm:py-2.5 ${
                  idx === activeIndex ? "bg-primary/10" : "hover:bg-muted/50"
                }`}
                onClick={() => onSelectProduct(p)}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[10px] font-bold ${
                      idx === activeIndex ? "bg-primary text-primary-foreground" : "bg-primary/10 text-primary"
                    }`}
                  >
                    {p.articleCode || p.code || "STK"}
                  </span>
                  <span className="min-w-0">
                    <span className="block break-words text-sm font-bold">{p.name}</span>
                    {p.nameAr && (
                      <span dir="rtl" className="block break-words text-xs text-muted-foreground">
                        {p.nameAr}
                      </span>
                    )}
                    <span className="block break-all font-mono text-xs text-muted-foreground">
                      {p.articleCode || p.code}
                    </span>
                  </span>
                </span>
                <Plus
                  className={`h-5 w-5 shrink-0 ${idx === activeIndex ? "text-primary" : "text-muted-foreground"}`}
                />
              </button>
            ))}
          </div>
        )}
      </div>
    </FactoryMobileScannerPanel>
  );
}
