import type { ComponentProps } from "react";
import { ExchangeRateInput } from "@/components/ExchangeRateInput";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { DraftRestorePrompt } from "@/components/DraftRestorePrompt";

type ExchangeRateInputProps = ComponentProps<typeof ExchangeRateInput>;

interface PaymentDraftAndRateBarProps {
  /** Age of the restorable draft; falsy hides the restore prompt. */
  draftAge: string | null;
  draftLabel: string;
  onRestoreDraft: () => void;
  onDiscardDraft: () => void;
  selectedCurrency: ExchangeRateInputProps["selectedCurrency"];
  transactionRate: ExchangeRateInputProps["value"];
  setTransactionRate: ExchangeRateInputProps["onChange"];
}

/** Draft-restore prompt and active foreign-currency rate input for Payment/Receipt. */
export function PaymentDraftAndRateBar({
  draftAge,
  draftLabel,
  onRestoreDraft,
  onDiscardDraft,
  selectedCurrency,
  transactionRate,
  setTransactionRate,
}: PaymentDraftAndRateBarProps) {
  const { baseCurrency, displayCurrency } = useCurrencyContext();
  return (
    <>
      {draftAge && (
        <DraftRestorePrompt
          draftAge={draftAge}
          label={draftLabel}
          onRestore={onRestoreDraft}
          onDiscard={onDiscardDraft}
        />
      )}
      {displayCurrency && selectedCurrency === displayCurrency && selectedCurrency !== baseCurrency && (
        <div className="flex flex-wrap items-center gap-2 sm:gap-4 p-3 bg-muted/30 rounded-md">
          <span className="text-sm text-muted-foreground">Transaction Rate:</span>
          <ExchangeRateInput
            value={transactionRate}
            onChange={setTransactionRate}
            selectedCurrency={selectedCurrency}
            disabled={selectedCurrency === "ZMW"}
          />
          {selectedCurrency === "ZMW" && (
            <span className="text-xs text-muted-foreground">
              {transactionRate ? "Approved date-specific rate (locked)" : "No approved rate for the voucher date"}
            </span>
          )}
        </div>
      )}
    </>
  );
}
