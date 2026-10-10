/**
 * ItemSearchPanel — extracted sub-component.
 *
 * Extracted from PosTransferOrders.tsx during the Phase 4 god-file split.
 */
import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { cn } from "@/lib/utils";

import { fmtQty } from "../utils";

const COPY = {
  en: {
    addItems: "Add Items",
    noItems: "No items found",
    out: "Out",
    close: "Close item picker",
  },
  ar: {
    addItems: "إضافة أصناف",
    noItems: "لم يتم العثور على أصناف",
    out: "نفد",
    close: "إغلاق اختيار الأصناف",
  },
  fr: {
    addItems: "Ajouter des articles",
    noItems: "Aucun article trouvé",
    out: "Épuisé",
    close: "Fermer le sélecteur d’articles",
  },
} as const;

export // ─── Right-side item search panel (results only — input lives in the bar) ──────
function ItemSearchPanel({
  matches,
  activeIdx,
  locationName,
  onActiveChange,
  onPick,
  onClose,
}: {
  matches: { stockItemId: number; name: string; quantity: string }[];
  activeIdx: number;
  locationName: string;
  onActiveChange: (i: number) => void;
  onPick: (item: { stockItemId: number; name: string }) => void;
  onClose: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const { language, direction } = useApplicationLanguage();
  const copy = COPY[language];
  const isRtl = direction === "rtl";

  useEffect(() => {
    if (listRef.current) {
      const active = listRef.current.querySelector("[data-active=true]") as HTMLElement | null;
      active?.scrollIntoView({ block: "nearest" });
    }
  }, [activeIdx]);

  return (
    <div className="flex h-full flex-col" dir={direction} data-i18n-portal>
      <div className="flex items-center justify-between gap-2 border-b bg-muted/30 px-3 py-2.5">
        <div className={cn("min-w-0", isRtl ? "text-right" : "text-left")}>
          <div className="text-sm font-semibold leading-tight" data-i18n-ui>
            {copy.addItems}
          </div>
          <div className="truncate text-xs text-muted-foreground" dir="auto" data-business-value>
            {locationName}
          </div>
        </div>
        <Button
          size="icon"
          variant="ghost"
          onClick={onClose}
          className="shrink-0"
          aria-label={copy.close}
          title={copy.close}
          data-testid="button-close-search-panel"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto">
        {matches.length === 0 ? (
          <div className="py-10 text-center text-xs text-muted-foreground" data-i18n-ui>
            {copy.noItems}
          </div>
        ) : (
          matches.map((item, i) => {
            const qty = parseFloat(item.quantity) || 0;
            const inStock = qty > 0;
            return (
              <button
                key={item.stockItemId}
                type="button"
                data-active={i === activeIdx}
                onClick={() => onPick(item)}
                onMouseEnter={() => onActiveChange(i)}
                className={cn(
                  "flex w-full items-center justify-between gap-3 border-b px-3 py-2.5 text-sm transition-none last:border-b-0",
                  isRtl ? "text-right" : "text-left",
                  i === activeIdx ? "bg-accent text-accent-foreground" : "hover-elevate"
                )}
                data-testid={`button-panel-item-${item.stockItemId}`}
              >
                <span className="min-w-0 flex-1 truncate text-sm" dir="auto" data-stock-name data-business-value>
                  {item.name}
                </span>
                {inStock ? (
                  <span
                    className="shrink-0 text-xs font-bold font-mono tabular-nums text-green-600 dark:text-green-400"
                    dir="ltr"
                    data-business-value
                  >
                    {fmtQty(qty)}
                  </span>
                ) : (
                  <span
                    className="shrink-0 rounded-xs bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground"
                    data-i18n-ui
                  >
                    {copy.out}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

// ─── Editable detail view ─────────────────────────────────────────────────────
