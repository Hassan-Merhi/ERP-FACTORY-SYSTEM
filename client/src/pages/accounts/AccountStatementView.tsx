import { useMemo, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  FileText,
  TrendingUp,
  TrendingDown,
  Scale,
  Trash2,
  MessageCircle,
  FileDown,
  FileSpreadsheet,
  X,
  Clock,
  Send,
  Loader2,
  ArrowLeft,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PeriodFilter } from "@/components/ui/period-filter";
import type { PeriodFilterValue } from "@/components/ui/period-filter";
import type { Account, Transaction, WaRule } from "./accountTypes";
import { AccountTransactionRows } from "./AccountTransactionRows";
import { AccountStatementCards } from "./AccountStatementCards";
import { ErpMobileActionsMenu, ErpMobileSummaryGrid } from "@/components/ui/erp-mobile-records";
import { useErpPhoneLayout } from "@/hooks/use-erp-phone-layout";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";

interface AccountStatementRow extends Transaction {
  totalDebit: number;
  totalCredit: number;
  runningBalance: number;
}

interface AccountStatementPageMetadata {
  total?: number;
  periodDebitTotal?: number;
  periodCreditTotal?: number;
  closingNetBalance?: number;
}

interface StatementSendMutation {
  isPending: boolean;
  mutate: (input: { accountId: number; month: string }) => void;
}

interface AccountStatementViewProps {
  selectedAccount: Account;
  onClose: () => void;
  periodFilter: PeriodFilterValue;
  setPeriodFilter: Dispatch<SetStateAction<PeriodFilterValue>>;
  vouchersWithBalance: AccountStatementRow[];
  closingBalance: number;
  openingBalance: number;
  transactionsLoading: boolean;
  transactionError?: string | null;
  selectedVoucherIds: Set<number>;
  toggleSelectAll: () => void;
  setShowBulkDeleteConfirm: Dispatch<SetStateAction<boolean>>;
  showDeletedVouchers: boolean;
  setShowDeletedVouchers: Dispatch<SetStateAction<boolean>>;
  formatAmount: (amt: number) => string;
  hideBalances: boolean;
  printRef: RefObject<HTMLDivElement | null>;
  appMode: string;
  formatDisplayDate: (date: Date | string) => string;
  toggleVoucherSelection: (id: number) => void;
  handleOpenVoucher: (voucher: AccountStatementRow) => void;
  waRule: WaRule | null;
  openWaRuleDialog: () => void;
  sendWaStatementMutation: StatementSendMutation;
  isBrokerSupplier: boolean;
  factoryStatementLoading: boolean;
  brokerStatementLoading: boolean;
}

export function AccountStatementView({
  selectedAccount,
  onClose,
  periodFilter,
  setPeriodFilter,
  vouchersWithBalance,
  closingBalance,
  openingBalance,
  transactionsLoading,
  selectedVoucherIds,
  toggleSelectAll,
  setShowBulkDeleteConfirm,
  showDeletedVouchers,
  setShowDeletedVouchers,
  formatAmount,
  hideBalances,
  printRef,
  appMode,
  formatDisplayDate,
  toggleVoucherSelection,
  handleOpenVoucher,
  openWaRuleDialog,
  waRule,
  sendWaStatementMutation,
  isBrokerSupplier,
  factoryStatementLoading,
  brokerStatementLoading,
  transactionError,
}: AccountStatementViewProps) {
  const { formatTransactionAmount } = useCurrencyContext();
  const { selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const isFactorySupplierAccount = selectedAccount?.type === "factorySupplier";
  const [pdfLang, setPdfLang] = useState<"en" | "fr" | "ar">("en");
  const isPhone = useErpPhoneLayout();

  const statementMetadata = queryClient.getQueryData<AccountStatementPageMetadata>([
    "account-statement",
    selectedCompany?.id,
    selectedAccount.type,
    selectedAccount.accountId,
    periodFilter.fromDate || null,
    periodFilter.toDate || null,
  ]);
  const rawOpeningBalance = Number.parseFloat(String(selectedAccount.openingBalance ?? 0)) || 0;
  const signedStoredOpening = selectedAccount.openingBalanceSide === "Cr" ? -rawOpeningBalance : rawOpeningBalance;
  const hasServerClosing = Number.isFinite(statementMetadata?.closingNetBalance);
  const isGoldenCoastFreshStart =
    selectedCompany?.companyType === "supplier_partner" && selectedAccount.subType === "gc_partner_capital";
  // Golden Coast Fresh Start is intentionally projected to Net Position in AccountsLegacy.
  // Every other paginated account uses the explicit server period aggregate carried by the
  // same React Query response, so financial totals no longer depend on the global pagination snapshot.
  const displayClosingBalance =
    !isGoldenCoastFreshStart && hasServerClosing
      ? signedStoredOpening + Number(statementMetadata?.closingNetBalance)
      : closingBalance;

  const pdfTypeMap: Record<string, string> = {
    ledger: "ledger",
    bank: "bank",
    "bank-account": "bank",
    supplier: "supplier",
    employee: "employee",
    customer: "customer",
    "fixed-asset": "fixed-asset",
  };

  const buildPdfUrl = (lang: "en" | "fr" | "ar" = pdfLang) => {
    if (!selectedAccount) return null;
    const serverType = pdfTypeMap[selectedAccount.type] || "ledger";
    const params = new URLSearchParams({ lang });
    if (periodFilter?.fromDate) params.set("startDate", periodFilter.fromDate);
    if (periodFilter?.toDate) params.set("endDate", periodFilter.toDate);
    return `/api/accounts/${serverType}/${selectedAccount.accountId}/statement-pdf?${params.toString()}`;
  };

  const canExportExcel = ["ledger", "bank-account", "bank", "supplier", "employee"].includes(selectedAccount.type);
  const exportExcel = () => {
    const typeMap: Record<string, string> = {
      ledger: "ledger",
      bank: "bank",
      "bank-account": "bank",
      supplier: "supplier",
      employee: "employee",
    };
    const serverType = typeMap[selectedAccount.type] || "ledger";
    const params = new URLSearchParams({
      accountType: serverType,
      accountId: String(selectedAccount.accountId),
    });
    if (periodFilter?.fromDate) params.set("startDate", periodFilter.fromDate);
    if (periodFilter?.toDate) params.set("endDate", periodFilter.toDate);
    window.open(`/api/accounts/statement/export-excel?${params.toString()}`, "_blank");
  };
  const sendWaStatement = () => {
    const month = periodFilter?.toDate ? periodFilter.toDate.substring(0, 7) : new Date().toISOString().substring(0, 7);
    sendWaStatementMutation.mutate({ accountId: selectedAccount.accountId, month });
  };
  const openPdf = (lang: "en" | "fr" | "ar") => {
    const url = buildPdfUrl(lang);
    if (url) window.open(url, "_blank");
  };
  const showWhatsApp = appMode === "factory" || appMode === "erp";

  const totalDebit = useMemo(
    () =>
      Number.isFinite(statementMetadata?.periodDebitTotal)
        ? Number(statementMetadata?.periodDebitTotal)
        : vouchersWithBalance.reduce((s, v) => s + (v.totalDebit || 0), 0),
    [statementMetadata?.periodDebitTotal, vouchersWithBalance]
  );
  const totalCredit = useMemo(
    () =>
      Number.isFinite(statementMetadata?.periodCreditTotal)
        ? Number(statementMetadata?.periodCreditTotal)
        : vouchersWithBalance.reduce((s, v) => s + (v.totalCredit || 0), 0),
    [statementMetadata?.periodCreditTotal, vouchersWithBalance]
  );
  const transactionCount = Number.isFinite(statementMetadata?.total)
    ? Number(statementMetadata?.total)
    : vouchersWithBalance.length;

  const balSide = (val: number) => (val >= 0 ? "Dr" : "Cr");

  if (isFactorySupplierAccount) {
    return (
      <div className="space-y-3">
        {/* Account info bar */}
        <div className="flex items-center justify-between gap-2 px-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs text-muted-foreground shrink-0">Account</span>
            <span className="font-semibold truncate">{selectedAccount?.name}</span>
            {selectedAccount?.accountId && (
              <Badge variant="outline" className="font-mono text-[10px] shrink-0">
                #{selectedAccount.accountId}
              </Badge>
            )}
          </div>
          <Button size="icon" variant="ghost" onClick={onClose} data-testid="button-close-ledger">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              {isBrokerSupplier ? "Broker Consolidated Statement" : "Factory Supplier"}: {selectedAccount?.name}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {factoryStatementLoading || (isBrokerSupplier && brokerStatementLoading) ? (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No statement data available.</p>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {isPhone ? (
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
                <p className="break-words text-base font-semibold leading-snug">{selectedAccount?.name}</p>
                {selectedAccount?.accountId && (
                  <p className="font-mono text-xs text-muted-foreground">#{selectedAccount.accountId}</p>
                )}
              </div>
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
                  { label: "PDF (English)", icon: FileDown, onSelect: () => openPdf("en"), testId: "button-pdf-en" },
                  { label: "PDF (Français)", icon: FileDown, onSelect: () => openPdf("fr"), testId: "button-pdf-fr" },
                  { label: "PDF (العربية)", icon: FileDown, onSelect: () => openPdf("ar"), testId: "button-pdf-ar" },
                  {
                    label: showDeletedVouchers ? "Hide Deleted" : "Show Deleted",
                    icon: Clock,
                    onSelect: () => setShowDeletedVouchers((p: boolean) => !p),
                    separated: true,
                    testId: "button-show-deleted",
                  },
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
            {!hideBalances && (
              <p
                className="mt-2 font-mono text-2xl font-semibold tabular-nums"
                dir="ltr"
                style={{ textAlign: "start" }}
              >
                {formatAmount(Math.abs(displayClosingBalance))}
                <span className="ms-1 text-sm font-normal opacity-70">{balSide(displayClosingBalance)}</span>
              </p>
            )}
          </div>
          <div className="[&>*]:w-full">
            <PeriodFilter value={periodFilter} onChange={setPeriodFilter} />
          </div>
        </div>
      ) : (
        <>
          {/* Compact account info bar */}
          <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted/30 px-3 py-2">
            <div className="flex items-center gap-2 min-w-0 flex-wrap">
              <span className="text-xs text-muted-foreground shrink-0">Account</span>
              <span className="font-semibold truncate max-w-[240px]">{selectedAccount?.name}</span>
              {selectedAccount?.accountId && (
                <span className="font-mono text-xs text-muted-foreground shrink-0">#{selectedAccount.accountId}</span>
              )}
              {!hideBalances && (
                <>
                  <span className="text-muted-foreground text-xs shrink-0">|</span>
                  <span className="text-sm font-mono tabular-nums shrink-0">
                    {formatAmount(Math.abs(displayClosingBalance))}
                    <span className="ml-1 text-[10px] opacity-70">{displayClosingBalance >= 0 ? "Dr" : "Cr"}</span>
                  </span>
                </>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {(appMode === "factory" || appMode === "erp") && (
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
                  {waRule?.enabled && (
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
              {selectedAccount &&
                ["ledger", "bank-account", "bank", "supplier", "employee"].includes(selectedAccount.type) && (
                  <Button
                    size="icon"
                    variant="ghost"
                    title="Export Excel Statement"
                    data-testid="button-export-excel"
                    onClick={exportExcel}
                  >
                    <FileSpreadsheet className="h-4 w-4 text-green-600" />
                  </Button>
                )}
              {/* Language toggle for PDF */}
              <div className="flex items-center rounded border text-[10px] font-semibold overflow-hidden">
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
              {/* PDF download */}
              <Button
                size="icon"
                variant="ghost"
                title="Download PDF Statement"
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
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h3 className="font-semibold text-base">Ledger: {selectedAccount?.name}</h3>
            <div className="flex items-center gap-2 flex-wrap">
              {selectedVoucherIds.size > 0 && (
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
              <Button
                variant={showDeletedVouchers ? "secondary" : "outline"}
                size="sm"
                onClick={() => setShowDeletedVouchers((p: boolean) => !p)}
                data-testid="button-show-deleted"
              >
                <Clock className="h-4 w-4 mr-1" />
                {showDeletedVouchers ? "Hide Deleted" : "Show Deleted"}
              </Button>
            </div>
          </div>
        </>
      )}

      {/* Error state */}
      {transactionError && !transactionsLoading && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          Failed to load this account period: {transactionError}
        </div>
      )}

      {/* Stats row */}
      {isPhone && !hideBalances && !transactionsLoading && !transactionError && (
        <ErpMobileSummaryGrid
          data-testid="account-statement-summary"
          items={[
            { label: "Transactions", value: transactionCount },
            {
              label: "Closing Balance",
              value: (
                <>
                  {formatAmount(Math.abs(displayClosingBalance))}
                  <span className="ms-1 text-[11px] font-normal opacity-70">{balSide(displayClosingBalance)}</span>
                </>
              ),
            },
            { label: "Total Debit", value: formatAmount(totalDebit) },
            { label: "Total Credit", value: formatAmount(totalCredit) },
          ]}
        />
      )}
      {!isPhone && !hideBalances && !transactionsLoading && !transactionError && (
        <div className="flex flex-wrap gap-3">
          <div className="rounded-lg border bg-muted/30 px-4 py-2.5 flex items-center gap-3 min-w-[130px]">
            <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
            <div>
              <p className="text-[10px] text-muted-foreground leading-none mb-0.5">Transactions</p>
              <p className="text-base font-semibold leading-none tabular-nums">{transactionCount}</p>
            </div>
          </div>
          <div className="rounded-lg border bg-muted/30 px-4 py-2.5 flex items-center gap-3 min-w-[150px]">
            <TrendingUp className="w-4 h-4 text-muted-foreground shrink-0" />
            <div>
              <p className="text-[10px] text-muted-foreground leading-none mb-0.5">Total Debit</p>
              <p className="text-base font-semibold leading-none tabular-nums">{formatAmount(totalDebit)}</p>
            </div>
          </div>
          <div className="rounded-lg border bg-muted/30 px-4 py-2.5 flex items-center gap-3 min-w-[150px]">
            <TrendingDown className="w-4 h-4 text-muted-foreground shrink-0" />
            <div>
              <p className="text-[10px] text-muted-foreground leading-none mb-0.5">Total Credit</p>
              <p className="text-base font-semibold leading-none tabular-nums">{formatAmount(totalCredit)}</p>
            </div>
          </div>
          <div className="rounded-lg border bg-muted/30 px-4 py-2.5 flex items-center gap-3 min-w-[160px]">
            <Scale className="w-4 h-4 text-muted-foreground shrink-0" />
            <div>
              <p className="text-[10px] text-muted-foreground leading-none mb-0.5">Closing Balance</p>
              <p className="text-base font-semibold leading-none tabular-nums">
                {formatAmount(Math.abs(displayClosingBalance))}
                <span className="ml-1 text-[10px] font-normal opacity-70">{balSide(displayClosingBalance)}</span>
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Table */}
      {transactionsLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : transactionError ? null : (
        <div ref={printRef as React.RefObject<HTMLDivElement>}>
          <AccountTransactionRows
            vouchersWithBalance={vouchersWithBalance}
            selectedVoucherIds={selectedVoucherIds}
            toggleSelectAll={toggleSelectAll}
            toggleVoucherSelection={toggleVoucherSelection}
            handleOpenVoucher={handleOpenVoucher}
            formatAmount={formatAmount}
            formatTransactionAmount={formatTransactionAmount}
            hideBalances={hideBalances}
            appMode={appMode}
            openingBalance={openingBalance}
            closingBalance={displayClosingBalance}
            selectedAccount={selectedAccount}
            formatDisplayDate={formatDisplayDate}
          />
        </div>
      )}
      {!transactionsLoading && !transactionError && (
        <AccountStatementCards
          vouchersWithBalance={vouchersWithBalance}
          selectedVoucherIds={selectedVoucherIds}
          handleOpenVoucher={handleOpenVoucher}
          formatAmount={formatAmount}
          formatTransactionAmount={formatTransactionAmount}
          hideBalances={hideBalances}
          openingBalance={openingBalance}
          closingBalance={displayClosingBalance}
          selectedAccount={selectedAccount}
          formatDisplayDate={formatDisplayDate}
        />
      )}
    </div>
  );
}
