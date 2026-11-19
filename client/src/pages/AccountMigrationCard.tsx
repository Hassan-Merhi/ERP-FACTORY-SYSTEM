// Extracted from ./AccountMigration.tsx
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { AccountMultiSelect, CompanyBadge } from "./AccountMultiSelect";
import { useAccountMigrationState } from "./useAccountMigrationState";

export function AccountMigrationCard({
  companies,
  companiesError,
  destCompanyId,
  loadingCompanies,
  loadingSrcAccounts,
  refetchCompanies,
  refetchSrcAccounts,
  selectedAccountIds,
  setPreview,
  setSelectedAccountIds,
  setSrcCompanyId,
  srcAccounts,
  srcAccountsError,
  srcAccountsQueryError,
  srcCompanyId,
}: Pick<
  ReturnType<typeof useAccountMigrationState>,
  | "companies"
  | "companiesError"
  | "destCompanyId"
  | "loadingCompanies"
  | "loadingSrcAccounts"
  | "refetchCompanies"
  | "refetchSrcAccounts"
  | "selectedAccountIds"
  | "setPreview"
  | "setSelectedAccountIds"
  | "setSrcCompanyId"
  | "srcAccounts"
  | "srcAccountsError"
  | "srcAccountsQueryError"
  | "srcCompanyId"
>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-xs text-primary-foreground">
            1
          </span>
          Source — pick company and accounts
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium">Source company</label>
          {loadingCompanies ? (
            <Skeleton className="h-10 w-full" />
          ) : companiesError ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              <p className="font-medium text-destructive">Companies could not be loaded.</p>
              <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => refetchCompanies()}>
                Retry
              </Button>
            </div>
          ) : (
            <Select
              value={srcCompanyId}
              onValueChange={(v) => {
                setSrcCompanyId(v);
                setSelectedAccountIds([]);
                setPreview(null);
              }}
            >
              <SelectTrigger data-testid="select-source-company">
                <SelectValue placeholder="Select company..." />
              </SelectTrigger>
              <SelectContent>
                {companies.map((company) => (
                  <SelectItem
                    key={company.id}
                    value={String(company.id)}
                    disabled={String(company.id) === destCompanyId}
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
        </div>

        {srcCompanyId && (
          <div className="space-y-2">
            <label className="text-sm font-medium">Accounts</label>
            {loadingSrcAccounts ? (
              <Skeleton className="h-10 w-full" />
            ) : srcAccountsError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                <p className="font-medium text-destructive">Accounts could not be loaded.</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {srcAccountsQueryError instanceof Error
                    ? srcAccountsQueryError.message
                    : "The source company accounts request failed."}
                </p>
                <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => refetchSrcAccounts()}>
                  Retry
                </Button>
              </div>
            ) : (
              <AccountMultiSelect
                accounts={srcAccounts}
                selectedIds={selectedAccountIds}
                onChange={(ids) => {
                  setSelectedAccountIds(ids);
                  setPreview(null);
                }}
              />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
