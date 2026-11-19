import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/PageHeader";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ArrowRight, CheckCircle, Undo2 } from "lucide-react";
import { CompanyBadge, fmtSigned } from "./AccountMultiSelect";
import { AccountPreviewRow } from "./AccountPreviewRow";
import { useAccountMigrationState } from "./useAccountMigrationState";
import { AccountMigrationCard } from "./AccountMigrationCard";

export default function AccountMigration() {
  const {
    canPreview,
    companies,
    companiesError,
    confirmOpen,
    destCompany,
    destCompanyId,
    executeMutation,
    loadingCompanies,
    loadingPending,
    loadingSrcAccounts,
    pendingError,
    pendingMigrations,
    preview,
    previewMutation,
    refetchCompanies,
    refetchPendingMigrations,
    refetchSrcAccounts,
    selectedAccountIds,
    setConfirmOpen,
    setDestCompanyId,
    setPreview,
    setSelectedAccountIds,
    setSrcCompanyId,
    setUndoTarget,
    srcAccounts,
    srcAccountsError,
    srcAccountsQueryError,
    srcCompany,
    srcCompanyId,
    undoMutation,
    undoTarget,
  } = useAccountMigrationState();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Account Migration"
        subtitle="Move one or more ledger accounts with their complete statement history to another company"
      />

      <AccountMigrationCard
        companies={companies}
        companiesError={companiesError}
        destCompanyId={destCompanyId}
        loadingCompanies={loadingCompanies}
        loadingSrcAccounts={loadingSrcAccounts}
        refetchCompanies={refetchCompanies}
        refetchSrcAccounts={refetchSrcAccounts}
        selectedAccountIds={selectedAccountIds}
        setPreview={setPreview}
        setSelectedAccountIds={setSelectedAccountIds}
        setSrcCompanyId={setSrcCompanyId}
        srcAccounts={srcAccounts}
        srcAccountsError={srcAccountsError}
        srcAccountsQueryError={srcAccountsQueryError}
        srcCompanyId={srcCompanyId}
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-xs text-primary-foreground">
              2
            </span>
            Destination company
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loadingCompanies ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <Select
              value={destCompanyId}
              onValueChange={(v) => {
                setDestCompanyId(v);
                setPreview(null);
              }}
            >
              <SelectTrigger data-testid="select-destination-company">
                <SelectValue placeholder="Select destination company..." />
              </SelectTrigger>
              <SelectContent>
                {companies.map((company) => (
                  <SelectItem
                    key={company.id}
                    value={String(company.id)}
                    disabled={String(company.id) === srcCompanyId}
                  >
                    <div className="flex items-center gap-2">
                      <span>{company.name}</span>
                      <CompanyBadge company={company} />
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </CardContent>
      </Card>

      <Button
        className="w-full"
        disabled={!canPreview || previewMutation.isPending}
        onClick={() => previewMutation.mutate()}
      >
        {previewMutation.isPending ? "Preparing preview..." : "Preview migration"}
      </Button>

      {preview && (
        <Card>
          <CardHeader>
            <CardTitle>Migration preview</CardTitle>
            <CardDescription>
              {srcCompany?.name} <ArrowRight className="inline h-3 w-3" /> {destCompany?.name}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-md border p-3">
                <p className="text-xs text-muted-foreground">Accounts</p>
                <p className="text-xl font-semibold">{preview.accounts.length}</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-xs text-muted-foreground">Posted entries</p>
                <p className="text-xl font-semibold">{preview.grandTotalEntries}</p>
                {preview.grandHistoryEntries !== preview.grandTotalEntries && (
                  <p className="text-xs text-muted-foreground">
                    {preview.grandHistoryEntries} historical entries in total
                  </p>
                )}
              </div>
              <div className="rounded-md border p-3">
                <p className="text-xs text-muted-foreground">Closing balance to transfer</p>
                <p className="text-xl font-semibold font-mono">{fmtSigned(preview.grandClosing)}</p>
              </div>
            </div>
            <div className="space-y-2">
              {preview.accounts.map((item) => (
                <AccountPreviewRow key={item.account.id} item={item} />
              ))}
            </div>
            <Button className="w-full" variant="destructive" onClick={() => setConfirmOpen(true)}>
              Execute migration
            </Button>
          </CardContent>
        </Card>
      )}

      {(loadingPending || pendingError || pendingMigrations.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle className="h-5 w-5" /> Active migrations — move accounts back
            </CardTitle>
            <CardDescription>
              Return an account after posting transactions in the temporary company. This list remains available after
              you leave the page.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {loadingPending ? (
              <Skeleton className="h-12 w-full" />
            ) : pendingError ? (
              <Button variant="outline" onClick={() => refetchPendingMigrations()}>
                Retry loading migrations
              </Button>
            ) : (
              pendingMigrations.map((migration) => {
                const source = companies.find((c) => c.id === migration.srcCompanyId);
                const destination = companies.find((c) => c.id === migration.destCompanyId);
                return (
                  <div
                    key={migration.migrationId}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
                  >
                    <div className="space-y-1">
                      <p className="text-sm font-medium">
                        {source?.name ?? `Company ${migration.srcCompanyId}`} <ArrowRight className="inline h-3 w-3" />{" "}
                        {destination?.name ?? `Company ${migration.destCompanyId}`}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {(migration.accounts ?? []).map((account) => account.originalCode).join(", ")}
                      </p>
                    </div>
                    <Button variant="outline" onClick={() => setUndoTarget(migration)}>
                      <Undo2 className="mr-2 h-4 w-4" /> Move back to {source?.name ?? "original company"}
                    </Button>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm account migration</DialogTitle>
            <DialogDescription>
              This will move {selectedAccountIds.length} account{selectedAccountIds.length === 1 ? "" : "s"} from{" "}
              {srcCompany?.name} to {destCompany?.name}.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={executeMutation.isPending} onClick={() => executeMutation.mutate()}>
              {executeMutation.isPending ? "Migrating..." : "Confirm migration"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!undoTarget}
        onOpenChange={(open) => {
          if (!open) setUndoTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move accounts back?</DialogTitle>
            <DialogDescription>
              Return {undoTarget?.accounts.length ?? 0} account(s) to{" "}
              {companies.find((company) => company.id === undoTarget?.srcCompanyId)?.name ?? "the original company"},
              including any new transactions posted while they were away.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUndoTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={undoMutation.isPending || !undoTarget}
              onClick={() => undoMutation.mutate()}
            >
              {undoMutation.isPending ? "Moving back..." : "Confirm move back"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
