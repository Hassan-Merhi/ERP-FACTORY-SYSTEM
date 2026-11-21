import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeftRight, ArrowRight, Check } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { formatUsd } from "@/lib/moneyDisplay";
import { AccountCombobox } from "./AccountCombobox";
import { useAccountTransferState } from "./useAccountTransferState";
import { AccountTransferCard } from "./AccountTransferCard";

export default function AccountTransfer() {
  const {
    fromAccountId,
    setFromAccountId,
    toAccountId,
    setToAccountId,
    setSelectedIds,
    selectedIds,
    setSearchEntries,
    searchEntries,
    setEntryPage,
    done,
    setDone,
    accounts,
    loadingEntries,
    entryData,
    entriesError,
    refetchEntries,
    entries,
    filteredEntries,
    allChecked,
    someChecked,
    toggleAll,
    toggleOne,
    totalDebit,
    totalCredit,
    fromAccount,
    toAccount,
    transfer,
    resetAll,
  } = useAccountTransferState();

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <PageHeader
        title="Account Transfer"
        subtitle="Move voucher entries from one ledger account to another"
        icon={<ArrowLeftRight className="h-6 w-6" />}
      />

      {done && (
        <Card className="border-green-500/30 bg-green-500/5">
          <CardContent className="pt-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-full bg-green-500/10">
                  <Check className="h-5 w-5 text-green-600 dark:text-green-400" />
                </div>
                <div>
                  <p className="font-semibold text-green-700 dark:text-green-300">Transfer complete</p>
                  <p className="text-sm text-muted-foreground">
                    {done.moved} {done.moved === 1 ? "entry" : "entries"} moved to{" "}
                    <span className="font-medium">{done.toAccount}</span>
                  </p>
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={resetAll} data-testid="button-transfer-again">
                Transfer again
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Source Account</CardTitle>
            <p className="text-sm text-muted-foreground">Entries will be moved away from this account</p>
          </CardHeader>
          <CardContent>
            <AccountCombobox
              accounts={accounts}
              value={fromAccountId}
              onChange={(id) => {
                setFromAccountId(id);
                setSelectedIds(new Set());
                setEntryPage(1);
                setSearchEntries("");
                setDone(null);
              }}
              placeholder="Select source account…"
              excludeId={toAccountId}
              testId="combobox-from-account"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Destination Account</CardTitle>
            <p className="text-sm text-muted-foreground">Selected entries will be re-assigned here</p>
          </CardHeader>
          <CardContent>
            <AccountCombobox
              accounts={accounts}
              value={toAccountId}
              onChange={(id) => {
                setToAccountId(id);
                setDone(null);
              }}
              placeholder="Select destination account…"
              excludeId={fromAccountId}
              testId="combobox-to-account"
            />
          </CardContent>
        </Card>
      </div>

      {fromAccountId && (
        <AccountTransferCard
          allChecked={allChecked}
          entries={entries}
          entriesError={entriesError}
          entryData={entryData}
          filteredEntries={filteredEntries}
          fromAccount={fromAccount}
          loadingEntries={loadingEntries}
          refetchEntries={refetchEntries}
          searchEntries={searchEntries}
          selectedIds={selectedIds}
          setEntryPage={setEntryPage}
          setSearchEntries={setSearchEntries}
          setSelectedIds={setSelectedIds}
          someChecked={someChecked}
          toggleAll={toggleAll}
          toggleOne={toggleOne}
        />
      )}

      {selectedIds.size > 0 && (
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="pt-4">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div className="space-y-1">
                <p className="text-sm font-semibold">
                  {selectedIds.size} {selectedIds.size === 1 ? "entry" : "entries"} selected
                </p>
                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  {totalDebit > 0 && (
                    <span>
                      Debit: <span className="font-medium text-foreground">{formatUsd(totalDebit, 2, 3)}</span>
                    </span>
                  )}
                  {totalCredit > 0 && (
                    <span>
                      Credit: <span className="font-medium text-foreground">{formatUsd(totalCredit, 2, 3)}</span>
                    </span>
                  )}
                </div>
                {fromAccount && toAccount && (
                  <div className="flex items-center gap-2 text-xs mt-1">
                    <span className="font-medium text-foreground">{fromAccount.name}</span>
                    <ArrowRight className="h-3 w-3 text-muted-foreground" />
                    <span className="font-medium text-foreground">{toAccount.name}</span>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSelectedIds(new Set())}
                  data-testid="button-clear-selection"
                >
                  Clear selection
                </Button>
                <Button
                  size="sm"
                  onClick={() => transfer.mutate()}
                  disabled={!toAccountId || transfer.isPending}
                  data-testid="button-execute-transfer"
                >
                  <ArrowLeftRight className="h-4 w-4 mr-1.5" />
                  {transfer.isPending
                    ? "Transferring…"
                    : !toAccountId
                      ? "Choose destination first"
                      : `Transfer ${selectedIds.size} ${selectedIds.size === 1 ? "entry" : "entries"}`}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
