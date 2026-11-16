// Extracted from ./AccountStatementView.tsx to keep that module under the source-size cap.
import { ArrowLeft, Clock, FileDown, FileSpreadsheet, MessageCircle, Send, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PeriodFilter } from "@/components/ui/period-filter";
import { PropertiesWhatsAppStatement } from "./PropertiesWhatsAppStatement";
import { FxAgentNativeBalance } from "./FxAgentNativeBalance";
import { ErpMobileActionsMenu } from "@/components/ui/erp-mobile-records";
import { drCrClass } from "@/lib/formatNumber";
import { useAccountStatementViewState } from "./useAccountStatementViewState";

export function AccountStatementViewAccountStatementPhoneHeader({
  appMode,
  balSide,
  canChangeExistingRecords,
  canExportExcel,
  destinationSelect,
  displayClosingBalance,
  exportExcel,
  formatAmount,
  hideBalances,
  isEurTab,
  nativeWallet,
  onClose,
  openPdf,
  openWaRuleDialog,
  periodFilter,
  phonePdfLanguage,
  selectedAccount,
  selectedVoucherIds,
  sendWaStatement,
  sendWaStatementMutation,
  setPeriodFilter,
  setShowBulkDeleteConfirm,
  setShowDeletedVouchers,
  showDeletedVouchers,
  showNativeBalance,
  showWhatsApp,
  waRule,
}: Pick<
  ReturnType<typeof useAccountStatementViewState>,
  | "appMode"
  | "balSide"
  | "canChangeExistingRecords"
  | "canExportExcel"
  | "destinationSelect"
  | "displayClosingBalance"
  | "exportExcel"
  | "formatAmount"
  | "hideBalances"
  | "isEurTab"
  | "nativeWallet"
  | "onClose"
  | "openPdf"
  | "openWaRuleDialog"
  | "periodFilter"
  | "phonePdfLanguage"
  | "selectedAccount"
  | "selectedVoucherIds"
  | "sendWaStatement"
  | "sendWaStatementMutation"
  | "setPeriodFilter"
  | "setShowBulkDeleteConfirm"
  | "setShowDeletedVouchers"
  | "showDeletedVouchers"
  | "showNativeBalance"
  | "showWhatsApp"
  | "waRule"
>) {
  return (
    <div className="space-y-3" data-testid="account-statement-phone-header">
      <div className="rounded-lg border bg-card p-3">
        <div className="flex items-start gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Back to accounts"
            data-testid="button-close-ledger"
            className="-ms-1 shrink-0"
          >
            <ArrowLeft className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
          </Button>
          <div className="min-w-0 flex-1">
            <p className="wrap-break-word text-base font-semibold leading-snug">{selectedAccount?.name}</p>
            {selectedAccount?.accountId && (
              <p className="font-mono text-xs text-muted-foreground">#{selectedAccount.accountId}</p>
            )}
          </div>
          {appMode === "properties" && selectedAccount.type === "ledger" && canChangeExistingRecords && !isEurTab && (
            <PropertiesWhatsAppStatement
              key={selectedAccount.accountId}
              accountId={selectedAccount.accountId}
              accountName={selectedAccount.name}
              fromDate={periodFilter.fromDate}
              toDate={periodFilter.toDate}
              compact
            />
          )}
          <ErpMobileActionsMenu
            iconOnly
            data-testid="button-statement-actions"
            actions={[
              showWhatsApp && {
                label: "WhatsApp rule",
                icon: MessageCircle,
                onSelect: openWaRuleDialog,
                testId: "button-wa-rule",
              },
              !isEurTab &&
                showWhatsApp &&
                waRule?.enabled && {
                  label: "Send statement via WhatsApp",
                  icon: Send,
                  disabled: sendWaStatementMutation.isPending,
                  onSelect: sendWaStatement,
                  testId: "button-wa-send",
                },
              canExportExcel && {
                label: "Export Excel",
                icon: FileSpreadsheet,
                onSelect: exportExcel,
                separated: true,
                testId: "button-export-excel",
              },
              {
                label: isEurTab ? "EUR PDF statement" : "PDF (English)",
                icon: FileDown,
                onSelect: () => openPdf("en"),
                testId: "button-pdf-en",
              },
              !isEurTab && {
                label: "PDF (Français)",
                icon: FileDown,
                onSelect: () => openPdf("fr"),
                testId: "button-pdf-fr",
              },
              !isEurTab && {
                label: "PDF (العربية)",
                icon: FileDown,
                onSelect: () => openPdf("ar"),
                testId: "button-pdf-ar",
              },
              !isEurTab && {
                label: showDeletedVouchers ? "Hide Deleted" : "Show Deleted",
                icon: Clock,
                onSelect: () => setShowDeletedVouchers((p: boolean) => !p),
                separated: true,
                testId: "button-show-deleted",
              },
              !isEurTab &&
                canChangeExistingRecords &&
                selectedVoucherIds.size > 0 && {
                  label: `Delete Selected (${selectedVoucherIds.size})`,
                  icon: Trash2,
                  destructive: true,
                  onSelect: () => setShowBulkDeleteConfirm(true),
                  testId: "button-bulk-delete",
                },
            ]}
          />
        </div>
        {!hideBalances &&
          (showNativeBalance ? (
            <div className="mt-2">
              <FxAgentNativeBalance wallet={nativeWallet!} compact />
            </div>
          ) : (
            <p
              className={`mt-2 font-mono text-2xl font-semibold tabular-nums ${drCrClass(balSide(displayClosingBalance))}`}
              dir="ltr"
              style={{ textAlign: "start" }}
            >
              {formatAmount(Math.abs(displayClosingBalance))}
              <span className="ms-1 text-sm font-normal opacity-70">{balSide(displayClosingBalance)}</span>
            </p>
          ))}
        {/* The everyday actions stay one tap away; exports in other languages, WhatsApp
                settings and deleted-voucher controls remain in the Actions menu. */}
        <div className="mt-3 grid grid-cols-2 gap-2 *:min-h-11" data-testid="account-statement-phone-actions">
          <Button
            type="button"
            variant="outline"
            className={showWhatsApp && waRule?.enabled && !isEurTab ? undefined : "col-span-2"}
            onClick={() => openPdf(phonePdfLanguage)}
            data-testid="button-pdf-phone"
          >
            <FileDown className="me-2 h-4 w-4" aria-hidden="true" />
            {isEurTab ? "EUR PDF" : "PDF"}
          </Button>
          {!isEurTab && showWhatsApp && waRule?.enabled && (
            <Button
              type="button"
              variant="outline"
              onClick={sendWaStatement}
              disabled={sendWaStatementMutation.isPending}
              data-testid="button-wa-send-phone"
            >
              <Send className="me-2 h-4 w-4" aria-hidden="true" />
              WhatsApp
            </Button>
          )}
        </div>
      </div>
      <div className="*:w-full">
        <PeriodFilter value={periodFilter} onChange={setPeriodFilter} />
        {destinationSelect}
      </div>
    </div>
  );
}
