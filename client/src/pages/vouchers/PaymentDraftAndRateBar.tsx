import type { ComponentProps } from "react";
import { ExchangeRateInput } from "@/components/ExchangeRateInput";
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

/** Draft-restore prompt and CFA transaction-rate input shown above the Payment/Receipt voucher forms. */
export function PaymentDraftAndRateBar({
  draftAge,
  draftLabel,
  onRestoreDraft,
  onDiscardDraft,
  selectedCurrency,
  transactionRate,
  setTransactionRate,
}: PaymentDraftAndRateBarProps) {
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
      {selectedCurrency === "CFA" && (
        <div className="flex flex-wrap items-center gap-2 sm:gap-4 p-3 bg-muted/30 rounded-md">
          <span className="text-sm text-muted-foreground">Transaction Rate:</span>
          <ExchangeRateInput
            value={transactionRate}
            onChange={setTransactionRate}
            selectedCurrency={selectedCurrency}
          />
        </div>
      )}
    </>
  );
}
