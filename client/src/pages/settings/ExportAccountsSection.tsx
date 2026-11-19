import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";

import { ExportButton } from "@/components/export/ReportExportMenu";
import { useExportAccountsSectionState } from "./useExportAccountsSectionState";

export function ExportAccountsSection() {
  const {
    selectedIds,
    fromDate,
    setFromDate,
    toDate,
    setToDate,
    exporting,
    search,
    setSearch,
    typeLabels,
    grouped,
    sortedGroupKeys,
    toggleAccount,
    selectAll,
    clearAll,
    handleExport,
  } = useExportAccountsSectionState();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold">Export Accounts</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Select accounts and an optional date range. Each account gets its own sheet in a single Excel workbook.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center justify-between flex-wrap gap-2">
              <span>Select Accounts</span>
              <div className="flex items-center gap-2">
                <Badge variant="secondary" data-testid="badge-selected-count">
                  {selectedIds.size} selected
                </Badge>
                <Button variant="ghost" size="sm" onClick={selectAll} data-testid="button-select-all-accounts">
                  Select All
                </Button>
                <Button variant="ghost" size="sm" onClick={clearAll} data-testid="button-clear-accounts">
                  Clear
                </Button>
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              placeholder="Search accounts..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid="input-account-search"
            />
            <div className="border rounded-md overflow-y-auto max-h-80 divide-y">
              {sortedGroupKeys.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-8">No accounts found</p>
              )}
              {sortedGroupKeys.map((type) => (
                <div key={type}>
                  <div className="text-xs font-semibold text-muted-foreground px-3 py-2 bg-muted/40 uppercase tracking-wide sticky top-0">
                    {typeLabels[type] || type}
                  </div>
                  {grouped[type].map((acc) => (
                    <label
                      key={acc.accountId}
                      className="flex items-center gap-3 px-3 py-2 cursor-pointer hover-elevate"
                      data-testid={`label-account-${acc.accountId}`}
                    >
                      <Checkbox
                        checked={selectedIds.has(acc.accountId)}
                        onCheckedChange={() => toggleAccount(acc.accountId)}
                        data-testid={`checkbox-account-${acc.accountId}`}
                      />
                      <span className="text-sm flex-1">{acc.name}</span>
                      {acc.balance !== undefined && (
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {acc.balanceSide}{" "}
                          {Math.abs(Number(acc.balance ?? 0)).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </span>
                      )}
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Date Range</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label>From</Label>
                <Input
                  type="date"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                  data-testid="input-export-from-date"
                />
              </div>
              <div className="space-y-1.5">
                <Label>To</Label>
                <Input
                  type="date"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                  data-testid="input-export-to-date"
                />
              </div>
              <p className="text-xs text-muted-foreground">Leave blank to include all transactions.</p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-5 space-y-3">
              <div className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Accounts</span>
                  <span className="font-medium">{selectedIds.size}</span>
                </div>
                {fromDate && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">From</span>
                    <span className="font-medium">{fromDate}</span>
                  </div>
                )}
                {toDate && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">To</span>
                    <span className="font-medium">{toDate}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Format</span>
                  <span className="font-medium">Excel (.xlsx)</span>
                </div>
              </div>
              <ExportButton
                kind="excel"
                busy={exporting}
                className="w-full"
                onClick={handleExport}
                disabled={exporting || selectedIds.size === 0}
                data-testid="button-export-accounts"
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
