import { FileText, TrendingUp, TrendingDown, Scale, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AccountTransactionRows } from "./AccountTransactionRows";
import { AccountStatementCards } from "./AccountStatementCards";
import { FxAgentEurStatement } from "./FxAgentEurStatement";
import { ErpMobileSummaryGrid } from "@/components/ui/erp-mobile-records";
import { drCrClass } from "@/lib/formatNumber";
import "./propertiesLedger.css";
import {
  AccountStatementOpeningBalanceKpi,
  OpeningBalanceAmount,
  openingBalanceLabel,
} from "./AccountStatementOpeningBalance";
import type { AccountStatementViewProps } from "./AccountStatementViewTypes";
import { useAccountStatementViewState } from "./useAccountStatementViewState";
import { AccountStatementViewSection } from "./AccountStatementViewSection";
import { AccountStatementViewAccountStatementPhoneHeader } from "./AccountStatementViewAccountStatementPhoneHeader";

export function AccountStatementView(props: AccountStatementViewProps) {
  const {
    appMode,
    balSide,
    brokerStatementLoading,
    buildPdfUrl,
    canChangeExistingRecords,
    canExportExcel,
    destinationFilter,
    destinationSelect,
    displayClosingBalance,
    exportExcel,
    factoryStatementLoading,
    filteredCount,
    formatAmount,
    formatDisplayDate,
    formatTransactionAmount,
    fxWalletId,
    handleOpenVoucher,
    hasFxTabs,
    hideBalances,
    isBrokerSupplier,
    isEurTab,
    isFactorySupplierAccount,
    isPhone,
    ledgerCompanyLabel,
    nativeWallet,
    onClose,
    openPdf,
    openWaRuleDialog,
    openingBalance,
    openingSide,
    pdfLang,
    periodFilter,
    phonePdfLanguage,
    printRef,
    selectedAccount,
    selectedVoucherIds,
    sendWaStatement,
    sendWaStatementMutation,
    setFxTabChoice,
    setPdfLang,
    setPeriodFilter,
    setShowBulkDeleteConfirm,
    setShowDeletedVouchers,
    showCustomerDestination,
    showDeletedVouchers,
    showNativeBalance,
    showWhatsApp,
    toggleSelectAll,
    toggleVoucherSelection,
    totalCredit,
    totalDebit,
    transactionCount,
    transactionError,
    transactionsLoading,
    vouchersWithBalance,
    waRule,
  } = useAccountStatementViewState(props);

  if (isFactorySupplierAccount) {
    return (
      <div className="account-ledger-modern space-y-4">
        {/* Account info bar */}
        <div className="flex items-center justify-between gap-2 px-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs text-muted-foreground shrink-0">Account</span>
            <span className="font-semibold truncate">{selectedAccount?.name}</span>
            {selectedAccount?.accountId && (
              <Badge variant="outline" className="font-mono text-[11px] shrink-0">
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
    <div className="account-ledger-modern space-y-4">
      {isPhone ? (
        <AccountStatementViewAccountStatementPhoneHeader
          appMode={appMode}
          balSide={balSide}
          canChangeExistingRecords={canChangeExistingRecords}
          canExportExcel={canExportExcel}
          destinationSelect={destinationSelect}
          displayClosingBalance={displayClosingBalance}
          exportExcel={exportExcel}
          formatAmount={formatAmount}
          hideBalances={hideBalances}
          isEurTab={isEurTab}
          nativeWallet={nativeWallet}
          onClose={onClose}
          openPdf={openPdf}
          openWaRuleDialog={openWaRuleDialog}
          periodFilter={periodFilter}
          phonePdfLanguage={phonePdfLanguage}
          selectedAccount={selectedAccount}
          selectedVoucherIds={selectedVoucherIds}
          sendWaStatement={sendWaStatement}
          sendWaStatementMutation={sendWaStatementMutation}
          setPeriodFilter={setPeriodFilter}
          setShowBulkDeleteConfirm={setShowBulkDeleteConfirm}
          setShowDeletedVouchers={setShowDeletedVouchers}
          showDeletedVouchers={showDeletedVouchers}
          showNativeBalance={showNativeBalance}
          showWhatsApp={showWhatsApp}
          waRule={waRule}
        />
      ) : (
        <AccountStatementViewSection
          appMode={appMode}
          balSide={balSide}
          buildPdfUrl={buildPdfUrl}
          canChangeExistingRecords={canChangeExistingRecords}
          destinationSelect={destinationSelect}
          displayClosingBalance={displayClosingBalance}
          exportExcel={exportExcel}
          formatAmount={formatAmount}
          hideBalances={hideBalances}
          isEurTab={isEurTab}
          ledgerCompanyLabel={ledgerCompanyLabel}
          nativeWallet={nativeWallet}
          onClose={onClose}
          openWaRuleDialog={openWaRuleDialog}
          pdfLang={pdfLang}
          periodFilter={periodFilter}
          selectedAccount={selectedAccount}
          selectedVoucherIds={selectedVoucherIds}
          sendWaStatement={sendWaStatement}
          sendWaStatementMutation={sendWaStatementMutation}
          setPdfLang={setPdfLang}
          setPeriodFilter={setPeriodFilter}
          setShowBulkDeleteConfirm={setShowBulkDeleteConfirm}
          setShowDeletedVouchers={setShowDeletedVouchers}
          showDeletedVouchers={showDeletedVouchers}
          showNativeBalance={showNativeBalance}
          showWhatsApp={showWhatsApp}
          waRule={waRule}
        />
      )}

      {hasFxTabs && (
        <div className="flex items-center justify-between gap-2 flex-wrap" data-testid="fx-agent-currency-tabs">
          <div
            className="inline-flex rounded-lg border bg-muted/30 p-1 gap-1"
            role="tablist"
            aria-label="FX transaction currency"
          >
            <Button
              type="button"
              size="sm"
              role="tab"
              aria-selected={isEurTab}
              variant={isEurTab ? "default" : "ghost"}
              data-testid="button-fx-eur-tab"
              onClick={() => setFxTabChoice({ accountId: selectedAccount.accountId, tab: "eur" })}
            >
              EUR · Native
            </Button>
            <Button
              type="button"
              size="sm"
              role="tab"
              aria-selected={!isEurTab}
              variant={!isEurTab ? "default" : "ghost"}
              data-testid="button-fx-usd-tab"
              onClick={() => setFxTabChoice({ accountId: selectedAccount.accountId, tab: "usd" })}
            >
              USD · Historical
            </Button>
          </div>
          <span className="text-xs text-muted-foreground">
            {isEurTab ? "Real EUR conversions and payments" : "Original USD accounting journal"}
          </span>
        </div>
      )}

      {/* Error state */}
      {!isEurTab && transactionError && !transactionsLoading && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          Failed to load this account period: {transactionError}
        </div>
      )}

      {showCustomerDestination && destinationFilter !== "all" && (
        <p className="text-xs text-muted-foreground" data-testid="customer-destination-filter-status">
          Showing {filteredCount} of {vouchersWithBalance.length} transactions. Destination filter only changes visible
          rows; running and closing balances remain for the entire account.
        </p>
      )}

      {/* Stats row */}
      {!isEurTab && isPhone && !hideBalances && !transactionsLoading && !transactionError && (
        <ErpMobileSummaryGrid
          data-testid="account-statement-summary"
          items={[
            { label: "Transactions", value: transactionCount },
            {
              label: openingBalanceLabel(showNativeBalance),
              value: (
                <OpeningBalanceAmount openingBalance={openingBalance} side={openingSide} formatAmount={formatAmount} />
              ),
            },
            {
              label: showNativeBalance ? "Historical USD closing" : "Closing Balance",
              value: (
                <>
                  {formatAmount(Math.abs(displayClosingBalance))}
                  <span
                    className={`ms-1 text-[11px] font-normal opacity-70 ${drCrClass(balSide(displayClosingBalance))}`}
                  >
                    {balSide(displayClosingBalance)}
                  </span>
                </>
              ),
            },
            { label: showNativeBalance ? "Historic USD debit" : "Total Debit", value: formatAmount(totalDebit) },
            { label: showNativeBalance ? "Historic USD credit" : "Total Credit", value: formatAmount(totalCredit) },
          ]}
        />
      )}
      {!isEurTab && !isPhone && !hideBalances && !transactionsLoading && !transactionError && (
        <div className="account-ledger-metrics">
          <div className="account-ledger-stat">
            <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
            <div>
              <p className="text-[11px] text-muted-foreground leading-none mb-0.5">Transactions</p>
              <p className="text-base font-semibold leading-none tabular-nums">{transactionCount}</p>
            </div>
          </div>
          <AccountStatementOpeningBalanceKpi
            showNativeBalance={showNativeBalance}
            openingBalance={openingBalance}
            side={openingSide}
            formatAmount={formatAmount}
          />
          <div className="account-ledger-stat">
            <TrendingUp className="w-4 h-4 text-muted-foreground shrink-0" />
            <div>
              <p className="text-[11px] text-muted-foreground leading-none mb-0.5">
                {showNativeBalance ? "Historical USD debit" : "Total Debit"}
              </p>
              <p className="text-base font-semibold leading-none tabular-nums">{formatAmount(totalDebit)}</p>
            </div>
          </div>
          <div className="account-ledger-stat">
            <TrendingDown className="w-4 h-4 text-muted-foreground shrink-0" />
            <div>
              <p className="text-[11px] text-muted-foreground leading-none mb-0.5">
                {showNativeBalance ? "Historical USD credit" : "Total Credit"}
              </p>
              <p className="text-base font-semibold leading-none tabular-nums">{formatAmount(totalCredit)}</p>
            </div>
          </div>
          <div className="account-ledger-stat">
            <Scale className="w-4 h-4 text-muted-foreground shrink-0" />
            <div>
              <p className="text-[11px] text-muted-foreground leading-none mb-0.5">
                {showNativeBalance ? "Historical USD closing" : "Closing Balance"}
              </p>
              <p
                className={`text-base font-semibold leading-none tabular-nums ${drCrClass(balSide(displayClosingBalance))}`}
              >
                <>
                  {formatAmount(Math.abs(displayClosingBalance))}
                  <span
                    className={`ml-1 text-[11px] font-normal opacity-70 ${drCrClass(balSide(displayClosingBalance))}`}
                  >
                    {balSide(displayClosingBalance)}
                  </span>
                </>
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Transactions are never blended across native EUR and historical USD. */}
      {isEurTab && fxWalletId ? (
        <FxAgentEurStatement walletId={fxWalletId} periodFilter={periodFilter} hideBalances={hideBalances} />
      ) : transactionsLoading ? (
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
            formatTransactionAmount={hasFxTabs ? undefined : formatTransactionAmount}
            hideBalances={hideBalances}
            appMode={appMode}
            openingBalance={openingBalance}
            closingBalance={displayClosingBalance}
            selectedAccount={selectedAccount}
            formatDisplayDate={formatDisplayDate}
            showCustomerDestination={showCustomerDestination}
            destinationFilter={destinationFilter}
          />
        </div>
      )}
      {!isEurTab && !transactionsLoading && !transactionError && (
        <AccountStatementCards
          vouchersWithBalance={vouchersWithBalance}
          selectedVoucherIds={selectedVoucherIds}
          handleOpenVoucher={handleOpenVoucher}
          formatAmount={formatAmount}
          formatTransactionAmount={hasFxTabs ? undefined : formatTransactionAmount}
          hideBalances={hideBalances}
          openingBalance={openingBalance}
          closingBalance={displayClosingBalance}
          selectedAccount={selectedAccount}
          formatDisplayDate={formatDisplayDate}
          showCustomerDestination={showCustomerDestination}
          destinationFilter={destinationFilter}
        />
      )}
    </div>
  );
}
