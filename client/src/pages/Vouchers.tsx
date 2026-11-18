import { Link } from "wouter";
import { PaymentVoucherTab } from "@/components/vouchers/PaymentVoucherTab";
import { ReceiptVoucherTab } from "@/components/vouchers/ReceiptVoucherTab";
import { CreditNoteTab } from "@/components/vouchers/CreditNoteTab";
import { CreateAccountModal } from "@/components/vouchers/CreateAccountModal";
import { PageHeader } from "@/components/PageHeader";
import { ArrowRightLeft } from "lucide-react";
import "@/pages/vouchers/pos-stock-transfer.css";
import "@/pages/vouchers/voucher-premium.css";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { VouchersProps } from "./vouchersPageSupport";
import StockTransferOrder from "@/pages/StockTransferOrder.tsx";
import { PrintTemplate } from "@/components/vouchers/PrintTemplate";
import { StockTransferForm } from "@/pages/vouchers/StockTransferForm";
import { StockAdjustmentForm } from "@/pages/vouchers/StockAdjustmentForm";
import { JournalForm } from "@/pages/vouchers/JournalForm";
import { VoucherMobileTabs, VoucherDesktopNav } from "@/pages/vouchers/VoucherTabNav";
import { PaymentDraftAndRateBar } from "@/pages/vouchers/PaymentDraftAndRateBar";

import { ErrorState } from "@/components/ui/page-state";
import { useVouchersModel } from "./VouchersModel";

export default function Vouchers({ posUser }: VouchersProps = {}) {
  const m = useVouchersModel({ posUser });

  return (
    <div
      className={`space-y-4 md:space-y-5 ${m.isPOS ? "pos-stock-transfer-page" : ""} ${!m.isPOS && (m.activeTab === "payment" || m.activeTab === "receipt" || m.activeTab === "journal") ? `voucher-workspace voucher-workspace--${m.activeTab}` : ""}`}
    >
      {m.isPOS ? (
        <PageHeader
          title="Stock Transfer"
          subtitle="Transfer stock between locations"
          icon={<ArrowRightLeft className="h-6 w-6" aria-hidden="true" />}
        />
      ) : (
        // One header for ERP, Factory and Properties; the drafts link is ERP-only via showOptionalDrafts.
        <PageHeader title="Vouchers" subtitle="Create and manage payment, receipt, and journal entries">
          {m.showOptionalDrafts && (
            <Link
              href="/optional-vouchers"
              className="inline-flex min-h-10 items-center rounded-lg border bg-card px-3 text-sm font-medium hover:bg-muted"
              data-testid="link-vouchers-optional-drafts"
            >
              Optional voucher drafts
            </Link>
          )}
        </PageHeader>
      )}

      {!m.isPOS && (
        <div className="hidden">
          <div ref={m.printRef}>
            <PrintTemplate
              voucherType={m.activeTab === "payment" ? "Payment" : "Receipt"}
              paymentAccountName={m.paymentAccountName}
              date={m.form.watch("voucherDate")}
              entries={m.entries.filter((e) => e.accountId > 0 && e.amount)}
              notes={m.form.watch("notes") || ""}
              total={m.total}
              formatAmount={m.formatAmount}
              companyName={m.selectedCompany?.name || ""}
            />
          </div>
        </div>
      )}

      {m.bankAccountsError || m.ledgerAccountsError || m.sidebarAccountsError ? (
        <ErrorState
          title="Voucher accounts unavailable"
          description="Some account choices could not be loaded. Retry before entering a voucher."
          actionLabel="Retry account data"
          onAction={() => {
            void m.refetchBankAccounts();
            void m.refetchLedgerAccounts();
            void m.refetchSidebarAccounts();
          }}
          className="border-destructive/30"
        />
      ) : null}

      {!m.isPOS && (
        <VoucherMobileTabs
          visibleSidebarGroups={m.visibleSidebarGroups}
          activeTab={m.activeTab}
          setActiveTab={(tab) => m.setActiveTab(tab as typeof m.activeTab)}
        />
      )}

      <div className="flex gap-5">
        {!m.isPOS && (
          <VoucherDesktopNav
            visibleSidebarGroups={m.visibleSidebarGroups}
            activeTab={m.activeTab}
            setActiveTab={(tab) => m.setActiveTab(tab as typeof m.activeTab)}
          />
        )}

        <div className="flex-1 min-w-0">
          {!m.isPOS && m.isFactoryMode && m.visibleVoucherTabs.length === 0 && (
            <div className="rounded-md border p-6 text-sm text-muted-foreground">
              No Voucher tabs are available for this user.
            </div>
          )}
          {!m.isPOS && m.canShowVoucherTab("payment") && m.activeTab === "payment" && (
            <div className="space-y-4">
              {m.normalIntercompany.details}
              <PaymentDraftAndRateBar
                draftAge={m.hasPaymentDraft && !m.voucherIdToEdit ? m.paymentDraftAge : null}
                draftLabel="Unsaved payment draft found"
                onRestoreDraft={m.restorePaymentDraft}
                onDiscardDraft={m.discardPaymentDraft}
                selectedCurrency={m.paymentPostingCurrency}
                transactionRate={m.paymentPostingCurrency === "ZMW" ? m.paymentPostingRate : m.transactionRate}
                setTransactionRate={m.setTransactionRate}
              />
              <PaymentVoucherTab
                form={m.form}
                fieldArray={m.fieldArray}
                entries={m.entries}
                total={m.total}
                paymentAccountId={m.paymentAccountId}
                paymentAccountType={m.paymentAccountType}
                paymentAccountName={m.paymentAccountName}
                accountBalance={m.accountBalance}
                accountCurrencyBalances={m.accountCurrencyBalances}
                allAccounts={m.allAccounts}
                payFromAccounts={m.paymentPayFromAccounts}
                sidebarAccounts={m.sidebarAccounts}
                isEditMode={!!m.voucherIdToEdit}
                filteredSidebarAccounts={m.filteredSidebarAccounts}
                sidebarSearchValue={m.sidebarSearchValue}
                setSidebarSearchValue={m.setSidebarSearchValue}
                sidebarHighlightedIndex={m.sidebarHighlightedIndex}
                setSidebarHighlightedIndex={m.setSidebarHighlightedIndex}
                selectedAccountId={m.selectedAccountId}
                selectedAccountType={m.selectedAccountType}
                handleSidebarAccountSelect={m.handleSidebarAccountSelect}
                handleAmountCommit={m.handleAmountCommit}
                handlePrint={m.handlePrint}
                handleExportVoucher={m.handleExportVoucher}
                onSubmit={m.onSubmit}
                activeTab="payment"
                activeRowIndex={m.activeRowIndex}
                setActiveRowIndex={m.setActiveRowIndex}
                onCreateAccount={() => m.handleOpenCreateAccountModal("payment", m.activeRowIndex ?? undefined)}
                isFactoryCompany={m.isFactoryCompany}
                onAutoCreateAccount={m.handleAutoCreateAccount}
                isAutoCreating={m.isAutoCreating}
                originalTotal={m.originalTotal}
                isPending={m.saveMutation.isPending}
                fxWallet={m.selectedFxWallet}
                fxWalletsLoading={m.fxWalletsLoading && m.isFactoryMode}
                fxPaymentRate={m.fxPaymentRate}
                onFxPaymentRateChange={m.setFxPaymentRate}
                fxPayoutCurrency={m.fxPayoutCurrency}
                fxSupplierEurBalance={m.fxSupplierId ? m.fxSupplierEurBalance : null}
                fxSupplierEurBasis={m.fxSupplierEurBasis}
                fxSupplierBalanceLoading={m.fxSupplierBalanceLoading}
                onFxPayoutCurrencyChange={m.changeFxPayoutCurrency}
                voucherNumber={m.voucherToEdit?.voucherNumber}
                onAccountPickerOpen={() => m.setAccountPickersNeeded(true)}
                onAccountSearchChange={m.setLiveAccountSearch}
                effectiveDate={m.voucherEffectiveDate}
                onEffectiveDateChange={m.setVoucherEffectiveDate}
              />
            </div>
          )}

          {!m.isPOS && m.canShowVoucherTab("receipt") && m.activeTab === "receipt" && (
            <div className="space-y-4">
              {m.normalIntercompany.details}
              <PaymentDraftAndRateBar
                draftAge={m.hasPaymentDraft && !m.voucherIdToEdit ? m.paymentDraftAge : null}
                draftLabel="Unsaved receipt draft found"
                onRestoreDraft={m.restorePaymentDraft}
                onDiscardDraft={m.discardPaymentDraft}
                selectedCurrency={m.selectedCurrency}
                transactionRate={m.transactionRate}
                setTransactionRate={m.setTransactionRate}
              />
              <ReceiptVoucherTab
                form={m.form}
                fieldArray={m.fieldArray}
                entries={m.entries}
                total={m.total}
                paymentAccountId={m.paymentAccountId}
                paymentAccountType={m.paymentAccountType}
                paymentAccountName={m.paymentAccountName}
                accountBalance={m.accountBalance}
                accountCurrencyBalances={m.accountCurrencyBalances}
                allAccounts={m.allAccounts}
                payFromAccounts={m.payFromAccounts}
                sidebarAccounts={m.sidebarAccounts}
                isEditMode={!!m.voucherIdToEdit}
                filteredSidebarAccounts={m.filteredSidebarAccounts}
                sidebarSearchValue={m.sidebarSearchValue}
                setSidebarSearchValue={m.setSidebarSearchValue}
                sidebarHighlightedIndex={m.sidebarHighlightedIndex}
                setSidebarHighlightedIndex={m.setSidebarHighlightedIndex}
                selectedAccountId={m.selectedAccountId}
                selectedAccountType={m.selectedAccountType}
                handleSidebarAccountSelect={m.handleSidebarAccountSelect}
                handleAmountCommit={m.handleAmountCommit}
                handlePrint={m.handlePrint}
                handleExportVoucher={m.handleExportVoucher}
                onSubmit={m.onSubmit}
                activeTab="receipt"
                activeRowIndex={m.activeRowIndex}
                setActiveRowIndex={m.setActiveRowIndex}
                onCreateAccount={() => m.handleOpenCreateAccountModal("receipt", m.activeRowIndex ?? undefined)}
                isFactoryCompany={m.isFactoryCompany}
                onAutoCreateAccount={m.handleAutoCreateAccount}
                isAutoCreating={m.isAutoCreating}
                originalTotal={m.originalTotal}
                isPending={m.saveMutation.isPending}
                voucherNumber={m.voucherToEdit?.voucherNumber}
                onAccountPickerOpen={() => m.setAccountPickersNeeded(true)}
                onAccountSearchChange={m.setLiveAccountSearch}
                effectiveDate={m.voucherEffectiveDate}
                onEffectiveDateChange={m.setVoucherEffectiveDate}
              />
            </div>
          )}

          {!m.isPOS && m.canShowVoucherTab("journal") && m.activeTab === "journal" && (
            <JournalForm voucherIdToEdit={m.voucherIdToEdit} isPOS={m.isPOS} />
          )}

          {(m.isPOS || (m.canShowVoucherTab("transfer") && m.activeTab === "transfer")) && (
            <StockTransferForm voucherIdToEdit={m.voucherIdToEdit} isPOS={m.isPOS} posUser={posUser ?? undefined} />
          )}

          {!m.isPOS && m.canShowVoucherTab("adjustment") && m.activeTab === "adjustment" && (
            <StockAdjustmentForm voucherIdToEdit={m.voucherIdToEdit} isPOS={m.isPOS} />
          )}

          {!m.isPOS && m.canShowVoucherTab("creditnote") && m.activeTab === "creditnote" && (
            <div className="space-y-4">
              <CreditNoteTab
                allAccounts={m.allAccounts}
                editVoucherId={m.activeTab === "creditnote" ? m.editVoucherId : null}
              />
            </div>
          )}

          {!m.isPOS && m.canShowVoucherTab("transferorder") && m.activeTab === "transferorder" && (
            <StockTransferOrder
              onSwitchToNormalView={() => {
                m.setActiveTab("transfer");
                if (m.voucherIdToEdit) {
                  m.setLocation(`/vouchers?edit=${m.voucherIdToEdit}&tab=transfer`);
                }
              }}
            />
          )}
        </div>
      </div>

      <CreateAccountModal
        open={m.showCreateAccountModal}
        onClose={() => {
          m.setShowCreateAccountModal(false);
          m.setCreateAccountContext(null);
        }}
        companyId={m.selectedCompany?.id || 0}
        onAccountCreated={m.handleAccountCreated}
        apiRequestFn={m.modeApiRequest}
      />

      <AlertDialog
        open={!!m.waPendingPrompt}
        onOpenChange={(open) => {
          if (!open) m.setWaPendingPrompt(null);
        }}
      >
        <AlertDialogContent data-testid="dialog-whatsapp-prompt">
          <AlertDialogHeader>
            <AlertDialogTitle>Send Statement via WhatsApp?</AlertDialogTitle>
            <AlertDialogDescription>
              A WhatsApp statement is configured for this account. Would you like to send the{" "}
              <strong>{m.waPendingPrompt?.month}</strong> statement now, or skip and send it manually later?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-whatsapp-skip" onClick={() => m.setWaPendingPrompt(null)}>
              Skip for Now
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-whatsapp-send"
              disabled={m.sendWaStatementMutation.isPending}
              onClick={() => m.waPendingPrompt && m.sendWaStatementMutation.mutate(m.waPendingPrompt)}
            >
              {m.sendWaStatementMutation.isPending ? "Sending..." : "Send Now"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
