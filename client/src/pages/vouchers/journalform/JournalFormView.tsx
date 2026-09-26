import { format } from "date-fns";
import { ExchangeRateInput } from "@/components/ExchangeRateInput";
import { DraftRestorePrompt } from "@/components/DraftRestorePrompt";
import { Card, CardContent } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { JournalAccountSidebar } from "./JournalAccountSidebar";
import { JournalEntriesEditor } from "./JournalEntriesEditor";
import { JournalFormDialogs } from "./JournalFormDialogs";
import type { useJournalFormModel } from "./useJournalFormModel";

type Model = ReturnType<typeof useJournalFormModel>;

export function JournalFormView({ model }: { model: Model }) {
  const {
    isPOS,
    selectedCurrency,
    transactionRate,
    setTransactionRate,
    hasJournalDraft,
    voucherIdToEdit,
    journalDraftAge,
    restoreJournalDraft,
    discardJournalDraft,
    journalForm,
    onJournalSubmit,
    voucherToEdit,
    journalEffectiveDate,
    setJournalEffectiveDate,
  } = model;

  if (isPOS) return null;

  return (
    <div className="space-y-4">
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

      <div className="flex flex-col lg:flex-row gap-4">
        <Card className="flex-1 min-w-0">
          <CardContent className="pt-5">
            <div className="flex items-center gap-2 mb-5">
              <span className="text-sm font-semibold">Journal Voucher</span>
            </div>

            {hasJournalDraft && !voucherIdToEdit && journalDraftAge && (
              <div className="mb-4">
                <DraftRestorePrompt
                  draftAge={journalDraftAge}
                  label="Unsaved journal draft found"
                  onRestore={restoreJournalDraft}
                  onDiscard={discardJournalDraft}
                />
              </div>
            )}

            <Form {...journalForm}>
              <form noValidate onSubmit={journalForm.handleSubmit(onJournalSubmit)} className="space-y-5">
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <div>
                    <p className="text-sm font-semibold">
                      {voucherToEdit?.voucherNumber ? `#${voucherToEdit.voucherNumber}` : "New Journal Entry"}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">Debit and credit must balance</p>
                  </div>

                  <FormField
                    control={journalForm.control}
                    name="voucherDate"
                    render={({ field }) => (
                      <FormItem className="flex items-center gap-2 space-y-0 max-sm:w-full">
                        <FormLabel className="text-sm text-muted-foreground shrink-0">Date</FormLabel>
                        <FormControl>
                          <Input
                            type="date"
                            value={
                              field.value instanceof Date
                                ? format(field.value, "yyyy-MM-dd")
                                : typeof field.value === "string"
                                  ? field.value
                                  : ""
                            }
                            onChange={(event) =>
                              field.onChange(
                                event.target.value ? new Date(event.target.value + "T00:00:00") : new Date()
                              )
                            }
                            className="w-[180px] max-sm:w-full max-sm:flex-1"
                            data-testid="input-journal-date"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div className="shrink-0 flex items-center gap-1.5 max-sm:w-full">
                    <span className="text-xs text-muted-foreground whitespace-nowrap">Eff.</span>
                    <Input
                      type="date"
                      className="w-36 max-sm:w-full max-sm:flex-1"
                      value={journalEffectiveDate}
                      onChange={(event) => setJournalEffectiveDate(event.target.value)}
                      data-testid="input-journal-effective-date"
                      title="Effective Date (optional — used for ledger/accounts)"
                    />
                  </div>
                </div>

                <JournalEntriesEditor model={model} />
              </form>
            </Form>
          </CardContent>
        </Card>

        <JournalAccountSidebar model={model} />
      </div>

      <JournalFormDialogs model={model} />
    </div>
  );
}
