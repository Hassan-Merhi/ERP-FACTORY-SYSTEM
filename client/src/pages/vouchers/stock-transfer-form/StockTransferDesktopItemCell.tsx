import { focusScopedTestId } from "@/lib/scopedFocus";
import type { StockTransferFormModel } from "./useStockTransferFormModel";

const focusInput = (id: string) => focusScopedTestId(id, { select: true, delay: 50 });

export function StockTransferDesktopItemCell({ model, index }: { model: StockTransferFormModel; index: number }) {
  const m = model;
  const entry = m.transferEntries[index];

  const chooseHighlightedItem = () => {
    const items = m.filteredTransferInventory;
    if (items.length === 0) return;
    const item = items[m.transferHighlightedIndex] || items[0];
    const stockItem = m.stockItems.find((candidate) => candidate.id === item.stockItemId);
    if (!stockItem) return;
    const sourceId = Number(m.transferInventorySource);
    if (!(sourceId > 0)) {
      m.toast({
        title: "Select a source location first",
        description: "Please select a source location from the inventory sidebar before adding items.",
        variant: "destructive",
      });
      return;
    }
    const location = m.locations.find((candidate) => candidate.id === sourceId);
    m.stockTransferForm.setValue(`entries.${index}.sourceLocationId`, sourceId, {
      shouldValidate: true,
      shouldDirty: true,
      shouldTouch: true,
    });
    m.stockTransferForm.setValue(`entries.${index}.sourceLocationName`, location?.name || "");
    m.stockTransferForm.setValue(`entries.${index}.stockItemId`, item.stockItemId, {
      shouldValidate: true,
      shouldDirty: true,
      shouldTouch: true,
    });
    m.stockTransferForm.setValue(`entries.${index}.stockItemCode`, stockItem.code || "");
    m.stockTransferForm.setValue(`entries.${index}.stockItemName`, stockItem.name);
    m.stockTransferForm.setValue(`entries.${index}.rate`, item.averageRate || "0");
    m.setTransferSearchTerm("");
    focusInput(`input-transfer-quantity-${index}`);
  };

  return (
    <div className="flex-1 min-w-[120px] border-r h-9 sm:h-10">
      <input
        type="text"
        value={
          m.activeTransferRow === index && m.activeFieldType === "item"
            ? m.transferSearchTerm
            : entry?.stockItemName || ""
        }
        onChange={(event) => {
          m.setTransferSearchTerm(event.target.value);
          m.setTransferHighlightedIndex(0);
          if (!event.target.value) {
            m.stockTransferForm.setValue(`entries.${index}.stockItemId`, 0);
            m.stockTransferForm.setValue(`entries.${index}.stockItemCode`, "");
            m.stockTransferForm.setValue(`entries.${index}.stockItemName`, "");
          }
        }}
        onFocus={() => {
          m.transferFocusIdRef.current += 1;
          m.setActiveTransferRow(index);
          m.setActiveFieldType("item");
          m.setTransferHighlightedIndex(0);
          m.setTransferSearchTerm(entry?.stockItemName || "");
          m.setShowItemSidebar(true);
          m.setShowSourceSidebar(false);
          if (entry?.sourceLocationId > 0) m.setTransferInventorySource(entry.sourceLocationId);
          else if (m.isPOS && m.posSelectedSourceId) m.setTransferInventorySource(m.posSelectedSourceId);
          else m.setTransferInventorySource(0);
        }}
        onBlur={() => {
          const focusId = m.transferFocusIdRef.current;
          setTimeout(() => {
            if (m.transferFocusIdRef.current === focusId) {
              m.setActiveTransferRow(null);
              m.setActiveFieldType(null);
              m.setTransferSearchTerm("");
              m.setShowItemSidebar(false);
            }
          }, 200);
        }}
        onKeyDown={(event) => {
          const items = m.filteredTransferInventory;
          if (event.key === "ArrowUp" && !event.shiftKey) {
            event.preventDefault();
            if (m.showItemSidebar && items.length > 0)
              m.setTransferHighlightedIndex(Math.max(0, m.transferHighlightedIndex - 1));
            else if (index > 0)
              focusScopedTestId(`input-item-name-${index - 1}`, {
                select: true,
                delay: 50,
                anchor: event.currentTarget,
              });
          } else if (event.key === "ArrowDown" && !event.shiftKey) {
            event.preventDefault();
            if (m.showItemSidebar && items.length > 0)
              m.setTransferHighlightedIndex(Math.min(items.length - 1, m.transferHighlightedIndex + 1));
            else if (index < m.transferFields.length - 1)
              focusScopedTestId(`input-item-name-${index + 1}`, {
                select: true,
                delay: 50,
                anchor: event.currentTarget,
              });
          } else if (event.key === "ArrowLeft" && !m.isPOS) {
            event.preventDefault();
            m.setShowItemSidebar(false);
            m.setTransferSearchTerm("");
            focusScopedTestId(`input-source-${index}`, { select: true, delay: 50, anchor: event.currentTarget });
          } else if (event.key === "ArrowRight" || (event.key === "Tab" && !event.shiftKey)) {
            event.preventDefault();
            focusScopedTestId(`input-transfer-quantity-${index}`, {
              select: true,
              delay: 50,
              anchor: event.currentTarget,
            });
          } else if (event.key === "Enter") {
            event.preventDefault();
            chooseHighlightedItem();
          }
        }}
        placeholder="Type to search..."
        className="w-full h-full px-3 bg-transparent outline-hidden focus:bg-accent/20"
        data-testid={`input-item-name-${index}`}
      />
    </div>
  );
}
