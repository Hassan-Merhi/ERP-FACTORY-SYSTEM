import { PageHeader } from "@/components/PageHeader";
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
import { formatUsdBase, useCompanyTransferState } from "./useCompanyTransferState";
import { CompanyTransferSection } from "./CompanyTransferSection";

export default function CompanyTransfer() {
  const {
    accountOptions,
    addingModule,
    autoConfigQueries,
    deleteConfirmRuleId,
    deleteRuleMutation,
    fromAccounts,
    handleSaveRule,
    isLoading,
    openAddRule,
    otherCompanies,
    ruleCashAccountIds,
    ruleDestAccountId,
    ruleDestAccounts,
    ruleDestCompanyId,
    ruleEnabled,
    saveRuleMutation,
    setAddingModule,
    setDeleteConfirmRuleId,
    setRuleDestAccountId,
    setRuleDestCompanyId,
    setRuleEnabled,
    setUndoTarget,
    toggleCashAccount,
    transfers,
    undoMutation,
    undoTarget,
  } = useCompanyTransferState();

  return (
    <div className="flex h-full flex-col overflow-auto">
      <div className="shrink-0 border-b px-6 py-4">
        <PageHeader
          title="Company Transfer"
          subtitle="Move a balance from one company to another. The amount is removed from the source and added to the destination."
        />
      </div>

      <CompanyTransferSection
        accountOptions={accountOptions}
        addingModule={addingModule}
        autoConfigQueries={autoConfigQueries}
        fromAccounts={fromAccounts}
        handleSaveRule={handleSaveRule}
        isLoading={isLoading}
        openAddRule={openAddRule}
        otherCompanies={otherCompanies}
        ruleCashAccountIds={ruleCashAccountIds}
        ruleDestAccountId={ruleDestAccountId}
        ruleDestAccounts={ruleDestAccounts}
        ruleDestCompanyId={ruleDestCompanyId}
        ruleEnabled={ruleEnabled}
        saveRuleMutation={saveRuleMutation}
        setAddingModule={setAddingModule}
        setDeleteConfirmRuleId={setDeleteConfirmRuleId}
        setRuleDestAccountId={setRuleDestAccountId}
        setRuleDestCompanyId={setRuleDestCompanyId}
        setRuleEnabled={setRuleEnabled}
        setUndoTarget={setUndoTarget}
        toggleCashAccount={toggleCashAccount}
        transfers={transfers}
      />

      <AlertDialog open={!!undoTarget} onOpenChange={(open) => !open && setUndoTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reverse this transfer?</AlertDialogTitle>
            <AlertDialogDescription>
              {undoTarget && (
                <>
                  This will reverse the <strong>{formatUsdBase(undoTarget.amount)}</strong> transfer from{" "}
                  <strong>{undoTarget.fromCompanyName}</strong> to <strong>{undoTarget.toCompanyName}</strong> on{" "}
                  <strong>{undoTarget.transferDate}</strong>.
                  <br />
                  <br />
                  Both company balances will return to their prior values and the transfer history entry will be
                  removed.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground"
              onClick={() => undoTarget && undoMutation.mutate(undoTarget.id)}
              data-testid="button-confirm-undo"
            >
              {undoMutation.isPending ? "Reversing…" : "Yes, Reverse It"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deleteConfirmRuleId} onOpenChange={(open) => !open && setDeleteConfirmRuleId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this auto-transfer rule?</AlertDialogTitle>
            <AlertDialogDescription>
              This rule will be deleted. Payments already processed are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground"
              onClick={() => deleteConfirmRuleId && deleteRuleMutation.mutate(deleteConfirmRuleId)}
              data-testid="button-confirm-delete-rule"
            >
              {deleteRuleMutation.isPending ? "Removing…" : "Remove Rule"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
