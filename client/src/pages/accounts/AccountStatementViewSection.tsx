// Extracted from ./AccountStatementView.tsx to keep that module under the source-size cap.
import {
  ChevronRight,
  Clock,
  FileDown,
  FileSpreadsheet,
  Landmark,
  Loader2,
  MessageCircle,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PeriodFilter } from "@/components/ui/period-filter";
import { PropertiesWhatsAppStatement } from "./PropertiesWhatsAppStatement";
import { FxAgentNativeBalance } from "./FxAgentNativeBalance";
import { drCrClass } from "@/lib/formatNumber";
import { useAccountStatementViewState } from "./useAccountStatementViewState";

export function AccountStatementViewSection({
  appMode,
  balSide,
  buildPdfUrl,
  canChangeExistingRecords,
  destinationSelect,
  displayClosingBalance,
  exportExcel,
  formatAmount,
  hideBalances,
  isEurTab,
  ledgerCompanyLabel,
  nativeWallet,
  onClose,
  openWaRuleDialog,
  pdfLang,
  periodFilter,
  selectedAccount,
  selectedVoucherIds,
  sendWaStatement,
  sendWaStatementMutation,
  setPdfLang,
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
  | "buildPdfUrl"
  | "canChangeExistingRecords"
  | "destinationSelect"
  | "displayClosingBalance"
  | "exportExcel"
  | "formatAmount"
  | "hideBalances"
  | "isEurTab"
  | "ledgerCompanyLabel"
  | "nativeWallet"
  | "onClose"
  | "openWaRuleDialog"
  | "pdfLang"
  | "periodFilter"
  | "selectedAccount"
  | "selectedVoucherIds"
  | "sendWaStatement"
  | "sendWaStatementMutation"
  | "setPdfLang"
  | "setPeriodFilter"
  | "setShowBulkDeleteConfirm"
  | "setShowDeletedVouchers"
  | "showDeletedVouchers"
  | "showNativeBalance"
  | "showWhatsApp"
  | "waRule"
>) {
  return (
    <div className="account-ledger-desktop-header">
      <nav className="account-ledger-breadcrumb" aria-label="Breadcrumb">
        <span>{ledgerCompanyLabel}</span>
        <ChevronRight className="h-3 w-3" aria-hidden="true" />
        <span>Accounts</span>
        <ChevronRight className="h-3 w-3" aria-hidden="true" />
        <strong>Ledger</strong>
      </nav>
      {/* Compact account info bar */}
      <div className="account-ledger-account-bar">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span className="text-xs text-muted-foreground shrink-0">Account</span>
          <span className="font-semibold truncate max-w-[240px]">{selectedAccount?.name}</span>
          {selectedAccount?.accountId && (
            <span className="font-mono text-xs text-muted-foreground shrink-0">#{selectedAccount.accountId}</span>
          )}
          {!hideBalances && (
            <>
              <span className="text-muted-foreground text-xs shrink-0">|</span>
              {showNativeBalance ? (
                <FxAgentNativeBalance wallet={nativeWallet!} compact />
              ) : (
                <span
                  className={`text-sm font-mono tabular-nums shrink-0 ${drCrClass(balSide(displayClosingBalance))}`}
                >
                  {formatAmount(Math.abs(displayClosingBalance))}
                  <span className="ml-1 text-[11px] opacity-70">{balSide(displayClosingBalance)}</span>
                </span>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {showWhatsApp && (
            <>
              <Button
                size="icon"
                variant="ghost"
                onClick={openWaRuleDialog}
                title="Configure WhatsApp rule"
                data-testid="button-wa-rule"
              >
                <MessageCircle className={`h-4 w-4 ${waRule?.enabled ? "text-green-500" : ""}`} />
              </Button>
              {!isEurTab && waRule?.enabled && (
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={sendWaStatementMutation.isPending}
                  onClick={sendWaStatement}
                  title="Send statement via WhatsApp"
                  data-testid="button-wa-send"
                >
                  {sendWaStatementMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4 text-green-500" />
                  )}
                </Button>
              )}
            </>
          )}
          {appMode === "properties" && selectedAccount.type === "ledger" && canChangeExistingRecords && !isEurTab && (
            <PropertiesWhatsAppStatement
              key={selectedAccount.accountId}
              accountId={selectedAccount.accountId}
              accountName={selectedAccount.name}
              fromDate={periodFilter.fromDate}
              toDate={periodFilter.toDate}
            />
          )}
          {selectedAccount &&
            ["ledger", "bank-account", "bank", "supplier", "employee"].includes(selectedAccount.type) && (
              <Button
                size="icon"
                variant="ghost"
                title={isEurTab ? "Export EUR Excel Statement" : "Export Excel Statement"}
                data-testid="button-export-excel"
                onClick={exportExcel}
              >
                <FileSpreadsheet className="h-4 w-4 text-green-600" />
              </Button>
            )}
          {/* Language selection applies to the historical USD PDF only. */}
          {!isEurTab && (
            <div className="flex items-center rounded-sm border text-[11px] font-semibold overflow-hidden">
              {(["en", "fr", "ar"] as const).map((l) => (
                <button
                  key={l}
                  onClick={() => setPdfLang(l)}
                  data-testid={`button-lang-${l}`}
                  className={`px-1.5 py-0.5 leading-none transition-colors ${pdfLang === l ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"}`}
                >
                  {l === "en" ? "EN" : l === "fr" ? "FR" : "عر"}
                </button>
              ))}
            </div>
          )}
          {/* PDF download */}
          <Button
            size="icon"
            variant="ghost"
            title={isEurTab ? "Download EUR PDF Statement" : "Download PDF Statement"}
            data-testid="button-pdf-download"
            onClick={() => {
              const url = buildPdfUrl();
              if (url) window.open(url, "_blank");
            }}
          >
            <FileDown className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="ghost" onClick={onClose} title="Close" data-testid="button-close-ledger">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Ledger heading + filters */}
      <div className="account-ledger-heading-row">
        <div className="account-ledger-heading-title">
          <div className="account-ledger-heading-icon">
            <Landmark className="h-6 w-6" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="account-ledger-subtitle">Account statement · #{selectedAccount.accountId}</p>
            <h3>Ledger: {selectedAccount?.name}</h3>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {!isEurTab && canChangeExistingRecords && selectedVoucherIds.size > 0 && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setShowBulkDeleteConfirm(true)}
              data-testid="button-bulk-delete"
            >
              <Trash2 className="h-4 w-4 mr-1" /> Delete Selected ({selectedVoucherIds.size})
            </Button>
          )}
          <PeriodFilter value={periodFilter} onChange={setPeriodFilter} />
          {destinationSelect}
          {!isEurTab && (
            <Button
              variant={showDeletedVouchers ? "secondary" : "outline"}
              size="sm"
              onClick={() => setShowDeletedVouchers((p: boolean) => !p)}
              data-testid="button-show-deleted"
            >
              <Clock className="h-4 w-4 mr-1" />
              {showDeletedVouchers ? "Hide Deleted" : "Show Deleted"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
