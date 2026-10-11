import { focusScopedTestId } from "@/lib/scopedFocus";
import type { StockTransferFormModel } from "./useStockTransferFormModel";

const focusInput = (id: string, delay = 50, anchor?: Element | null) =>
  focusScopedTestId(id, { select: true, delay, anchor });

export function StockTransferDesktopQuantityCells({ model, index }: { model: StockTransferFormModel; index: number }) {
  const m = model;
  const entry = m.transferEntries[index];
  const appendAndFocus = (anchor?: Element | null) => {
    m.appendTransfer({
      sourceLocationId: 0,
      sourceLocationName: "",
      stockItemId: 0,
      stockItemCode: "",
      stockItemName: "",
      quantity: "",
      rate: "",
    });
    focusInput(m.isPOS ? `input-item-name-${index + 1}` : `input-source-${index + 1}`, 100, anchor);
  };

  return (
    <>
      <div className="w-16 sm:w-24 border-r h-9 sm:h-10">
        <input
          type="text"
          inputMode="decimal"
          value={m.transferQtyDraft[index] !== undefined ? m.transferQtyDraft[index] : entry?.quantity || ""}
          onFocus={() => m.setTransferQtyDraft((draft) => ({ ...draft, [index]: entry?.quantity || "" }))}
          onChange={(event) => {
            const raw = event.target.value;
            m.setTransferQtyDraft((draft) => ({ ...draft, [index]: raw }));
            if (!raw.startsWith("+") && !raw.startsWith("-"))
              m.stockTransferForm.setValue(`entries.${index}.quantity`, raw);
          }}
          onBlur={(event) => {
            const raw = (m.transferQtyDraft[index] ?? event.target.value).trim();
            m.setTransferQtyDraft((draft) => {
              const next = { ...draft };
              delete next[index];
              return next;
            });
            const delta = parseFloat(raw.startsWith("+") ? raw.slice(1) : raw);
            if (isNaN(delta)) return;
            if (m.voucherIdToEdit && m.stockTransferToEdit?.items) {
              const current = m.stockTransferForm.getValues(`entries.${index}`);
              const original = (
                m.stockTransferToEdit.items as { stockItemId: number; sourceLocationId: number; quantity: string }[]
              ).find(
                (item) => item.stockItemId === current.stockItemId && item.sourceLocationId === current.sourceLocationId
              );
              const originalQuantity = original ? parseFloat(original.quantity) || 0 : 0;
              m.stockTransferForm.setValue(
                `entries.${index}.quantity`,
                Math.max(0, originalQuantity + delta).toString()
              );
            } else m.stockTransferForm.setValue(`entries.${index}.quantity`, Math.max(0, delta).toString());
          }}
          onKeyDown={(event) => {
            const anchor = event.currentTarget;
            if (event.key === "ArrowUp") {
              event.preventDefault();
              if (index > 0) focusInput(`input-transfer-quantity-${index - 1}`, 50, anchor);
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              if (index < m.transferFields.length - 1) focusInput(`input-transfer-quantity-${index + 1}`, 50, anchor);
            } else if (event.key === "ArrowLeft") {
              event.preventDefault();
              focusInput(`input-item-name-${index}`, 50, anchor);
            } else if (event.key === "ArrowRight" && !m.isPOS) {
              event.preventDefault();
              focusInput(`input-transfer-rate-${index}`, 50, anchor);
            } else if (event.key === "Tab" && !event.shiftKey) {
              event.preventDefault();
              if (!m.isPOS) focusInput(`input-transfer-rate-${index}`, 50, anchor);
              else if (index < m.transferFields.length - 1) focusInput(`input-item-name-${index + 1}`, 50, anchor);
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (index === m.transferFields.length - 1) appendAndFocus(anchor);
            }
          }}
          placeholder={m.voucherIdToEdit ? "-1 to reduce, 2 to add" : "0"}
          className="w-full h-full px-3 bg-transparent outline-hidden focus:bg-accent/20 font-mono text-right"
          data-testid={`input-transfer-quantity-${index}`}
        />
      </div>
      {!m.isPOS && (
        <>
          <div className="w-16 sm:w-24 border-r h-9 sm:h-10">
            <input
              type="number"
              step="0.01"
              value={entry?.rate || ""}
              onChange={(event) => m.stockTransferForm.setValue(`entries.${index}.rate`, event.target.value)}
              onKeyDown={(event) => {
                const anchor = event.currentTarget;
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  if (index > 0) focusInput(`input-transfer-rate-${index - 1}`, 50, anchor);
                } else if (event.key === "ArrowDown") {
                  event.preventDefault();
                  if (index < m.transferFields.length - 1) focusInput(`input-transfer-rate-${index + 1}`, 50, anchor);
                } else if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  focusInput(`input-transfer-quantity-${index}`, 50, anchor);
                } else if (event.key === "Tab" && !event.shiftKey) {
                  event.preventDefault();
                  if (index < m.transferFields.length - 1) focusInput(`input-item-name-${index + 1}`, 50, anchor);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  if (index === m.transferFields.length - 1) appendAndFocus(anchor);
                }
              }}
              placeholder="0"
              className="w-full h-full px-3 bg-transparent outline-hidden focus:bg-accent/20 font-mono text-right"
              data-testid={`input-transfer-rate-${index}`}
            />
          </div>
          <div className="w-20 sm:w-28 border-r h-9 sm:h-10 bg-muted/30 flex items-center justify-end px-2 sm:px-3 font-mono text-xs sm:text-sm">
            {m.formatAmount(parseFloat(entry?.quantity || "0") * parseFloat(entry?.rate || "0"))}
          </div>
        </>
      )}
    </>
  );
}
