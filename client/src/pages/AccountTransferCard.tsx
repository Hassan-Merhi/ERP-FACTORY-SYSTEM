// Extracted from ./AccountTransfer.tsx
import { SearchField } from "@/components/ui/search-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/page-state";
import { Checkbox } from "@/components/ui/checkbox";
import { format } from "date-fns";
import { fmtMoney } from "./AccountCombobox";
import { useAccountTransferState } from "./useAccountTransferState";

export function AccountTransferCard({
  allChecked,
  entries,
  entriesError,
  entryData,
  filteredEntries,
  fromAccount,
  loadingEntries,
  refetchEntries,
  searchEntries,
  selectedIds,
  setEntryPage,
  setSearchEntries,
  setSelectedIds,
  someChecked,
  toggleAll,
  toggleOne,
}: Pick<
  ReturnType<typeof useAccountTransferState>,
  | "allChecked"
  | "entries"
  | "entriesError"
  | "entryData"
  | "filteredEntries"
  | "fromAccount"
  | "loadingEntries"
  | "refetchEntries"
  | "searchEntries"
  | "selectedIds"
  | "setEntryPage"
  | "setSearchEntries"
  | "setSelectedIds"
  | "someChecked"
  | "toggleAll"
  | "toggleOne"
>) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <CardTitle className="text-base">
              Entries under <span className="text-primary">{fromAccount?.name}</span>
              {!loadingEntries && (
                <Badge variant="secondary" className="ml-2">
                  {entryData?.total ?? entries.length}
                </Badge>
              )}
            </CardTitle>
            <p className="text-sm text-muted-foreground mt-0.5">Select which entries to transfer</p>
          </div>
          <div className="flex items-center gap-2">
            <SearchField
              value={searchEntries}
              onValueChange={(value) => {
                setSearchEntries(value);
                setEntryPage(1);
                setSelectedIds(new Set());
              }}
              placeholder="Filter entries…"
              wrapperClassName="w-52"
              className="text-sm"
              data-testid="input-search-entries"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {loadingEntries ? (
          <LoadingState title="Loading entries…" className="py-10" />
        ) : entriesError && !entryData ? (
          <ErrorState onAction={() => void refetchEntries()} actionLabel="Try again" className="py-10" />
        ) : entries.length === 0 ? (
          <EmptyState title="No entries found for this account" className="py-10" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-4 py-2 text-left w-10">
                    <Checkbox
                      checked={allChecked}
                      onCheckedChange={toggleAll}
                      data-testid="checkbox-select-all"
                      ref={(el) => {
                        if (el)
                          (el as unknown as HTMLButtonElement & { indeterminate: boolean }).indeterminate =
                            someChecked && !allChecked;
                      }}
                    />
                  </th>
                  <th className="px-3 py-2 text-left font-semibold text-xs uppercase tracking-wide">Voucher #</th>
                  <th className="px-3 py-2 text-left font-semibold text-xs uppercase tracking-wide">Date</th>
                  <th className="px-3 py-2 text-left font-semibold text-xs uppercase tracking-wide">Type</th>
                  <th className="px-3 py-2 text-left font-semibold text-xs uppercase tracking-wide">
                    Description / Narration
                  </th>
                  <th className="px-3 py-2 text-right font-semibold text-xs uppercase tracking-wide">Debit</th>
                  <th className="px-3 py-2 text-right font-semibold text-xs uppercase tracking-wide">Credit</th>
                </tr>
              </thead>
              <tbody>
                {filteredEntries.map((e) => {
                  const checked = selectedIds.has(e.id);
                  const label = e.narration || e.voucherDescription || "—";
                  const dr = fmtMoney(e.debitAmount);
                  const cr = fmtMoney(e.creditAmount);
                  return (
                    <tr
                      key={e.id}
                      className={`border-t cursor-pointer hover-elevate ${checked ? "bg-primary/5" : ""}`}
                      onClick={() => toggleOne(e.id)}
                      data-testid={`row-entry-${e.id}`}
                    >
                      <td className="px-4 py-2" onClick={(ev) => ev.stopPropagation()}>
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() => toggleOne(e.id)}
                          data-testid={`checkbox-entry-${e.id}`}
                        />
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{e.voucherNumber}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                        {e.voucherDate ? format(new Date(e.voucherDate), "dd MMM yyyy") : "—"}
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant="outline" className="text-xs">
                          {e.voucherType}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground max-w-xs truncate" title={label}>
                        {label}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-xs">
                        {dr ? (
                          <span className="font-medium">{dr}</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-xs">
                        {cr ? (
                          <span className="font-medium">{cr}</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {entryData && entryData.totalPages > 1 && (
              <div className="flex items-center justify-between gap-3 border-t px-4 py-3">
                <p className="text-xs text-muted-foreground">
                  Page {entryData.page} of {entryData.totalPages} · {entryData.total} entries
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!entryData.hasPreviousPage}
                    onClick={() => {
                      setSelectedIds(new Set());
                      setEntryPage((page) => Math.max(1, page - 1));
                    }}
                    data-testid="button-entries-previous-page"
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!entryData.hasNextPage}
                    onClick={() => {
                      setSelectedIds(new Set());
                      setEntryPage((page) => page + 1);
                    }}
                    data-testid="button-entries-next-page"
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
