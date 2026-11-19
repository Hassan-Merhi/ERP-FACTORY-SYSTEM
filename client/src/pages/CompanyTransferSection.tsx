// Extracted from ./CompanyTransfer.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Undo2, Zap } from "lucide-react";
import { formatUsdBase, useCompanyTransferState } from "./useCompanyTransferState";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/page-state";
import { RowsExportMenu } from "@/components/export/RowsExportMenu";
import { CompanyTransferSectionCardContent } from "./CompanyTransferSectionCardContent";

export function CompanyTransferSection({
  transfersError,
  refetchTransfers,
  accountOptions,
  addingModule,
  autoConfigQueries,
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
}: Pick<
  ReturnType<typeof useCompanyTransferState>,
  | "accountOptions"
  | "addingModule"
  | "autoConfigQueries"
  | "fromAccounts"
  | "handleSaveRule"
  | "isLoading"
  | "openAddRule"
  | "otherCompanies"
  | "ruleCashAccountIds"
  | "ruleDestAccountId"
  | "ruleDestAccounts"
  | "ruleDestCompanyId"
  | "ruleEnabled"
  | "saveRuleMutation"
  | "setAddingModule"
  | "setDeleteConfirmRuleId"
  | "setRuleDestAccountId"
  | "setRuleDestCompanyId"
  | "setRuleEnabled"
  | "setUndoTarget"
  | "toggleCashAccount"
  | "transfers"
  | "refetchTransfers"
  | "transfersError"
>) {
  return (
    <div className="space-y-6 p-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Zap className="h-4 w-4 text-amber-500" />
            Automatic Transfer Rules
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            When a rental payment is recorded, all matching rules fire automatically. Add multiple rules per module to
            route different cash accounts to different destinations.
          </p>
        </CardHeader>
        <CompanyTransferSectionCardContent
          accountOptions={accountOptions}
          addingModule={addingModule}
          autoConfigQueries={autoConfigQueries}
          fromAccounts={fromAccounts}
          handleSaveRule={handleSaveRule}
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
          toggleCashAccount={toggleCashAccount}
        />
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-base">Transfer History</CardTitle>
          <RowsExportMenu
            title="Company Transfer History"
            sheetName="Transfer History"
            rows={transfers}
            columns={[
              { header: "Date", value: (transfer) => transfer.transferDate },
              { header: "From", value: (transfer) => transfer.fromCompanyName },
              { header: "From Account", value: (transfer) => transfer.fromAccountName },
              { header: "To", value: (transfer) => transfer.toCompanyName },
              { header: "To Account", value: (transfer) => transfer.toAccountName },
              { header: "Amount (USD)", value: (transfer) => transfer.amount, type: "number" },
              { header: "Note", value: (transfer) => transfer.description ?? "—" },
            ]}
            resource="erp.accounts"
          />
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <LoadingState className="m-4" />
          ) : transfersError && transfers.length === 0 ? (
            <ErrorState onAction={() => void refetchTransfers()} actionLabel="Try again" className="m-4" />
          ) : transfers.length === 0 ? (
            <EmptyState title="No transfers yet." className="m-4" />
          ) : (
            <Table>
              <TableHeader className="sticky top-0 z-30 bg-background">
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>From Account</TableHead>
                  <TableHead>To</TableHead>
                  <TableHead>To Account</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Note</TableHead>
                  <TableHead className="text-right">Undo</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {transfers.map((transfer) => (
                  <TableRow key={transfer.id} data-testid={`row-transfer-${transfer.id}`}>
                    <TableCell className="text-sm">{transfer.transferDate}</TableCell>
                    <TableCell className="text-sm font-medium">{transfer.fromCompanyName}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{transfer.fromAccountName}</TableCell>
                    <TableCell className="text-sm font-medium">{transfer.toCompanyName}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{transfer.toAccountName}</TableCell>
                    <TableCell className="font-mono text-sm font-semibold">{formatUsdBase(transfer.amount)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{transfer.description ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => setUndoTarget(transfer)}
                        data-testid={`button-undo-${transfer.id}`}
                      >
                        <Undo2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
