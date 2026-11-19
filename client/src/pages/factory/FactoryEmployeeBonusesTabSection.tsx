// Extracted from ./FactoryEmployeeBonusesTab.tsx to keep that module under the source-size cap.
import { Columns3, Filter, Gift, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { fmt, useFactoryEmployeeBonusesTabState } from "./useFactoryEmployeeBonusesTabState";
import { SearchField } from "@/components/ui/search-field";
import { PeriodFilter } from "@/components/ui/period-filter";
import { FactoryEmployeeBonusesTabSectionContent } from "./FactoryEmployeeBonusesTabSectionContent";

export function FactoryEmployeeBonusesTabSection({
  bonuses,
  empFilter,
  employees,
  endDate,
  exportBonusesCsv,
  isLoading,
  recordChanges,
  search,
  setAddOpen,
  setDeleteConfirm,
  setEmpFilter,
  setEndDate,
  setSearch,
  setShowFilters,
  setStartDate,
  setVisibleColumns,
  showFilters,
  shownBonuses,
  startDate,
  totalBonuses,
  visibleColumns,
}: Pick<
  ReturnType<typeof useFactoryEmployeeBonusesTabState>,
  | "bonuses"
  | "empFilter"
  | "employees"
  | "endDate"
  | "exportBonusesCsv"
  | "isLoading"
  | "recordChanges"
  | "search"
  | "setAddOpen"
  | "setDeleteConfirm"
  | "setEmpFilter"
  | "setEndDate"
  | "setSearch"
  | "setShowFilters"
  | "setStartDate"
  | "setVisibleColumns"
  | "showFilters"
  | "shownBonuses"
  | "startDate"
  | "totalBonuses"
  | "visibleColumns"
>) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm">
      {/* Employees hub "Bonuses" tab: the Payroll hub PageHeader titles the page; keep the record count only. */}
      <div className="flex flex-wrap items-center justify-end gap-3 border-b border-border/70 px-4 py-3 sm:px-5">
        <span className="rounded-full border border-emerald-200 bg-background/80 px-3 py-1 text-xs font-medium text-emerald-700 dark:border-emerald-800 dark:text-emerald-300">
          {isLoading ? "Loading bonuses" : shownBonuses.length + " records"}
        </span>
      </div>
      <div className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap gap-3 items-end justify-between">
          <div>
            <Label className="text-xs text-muted-foreground mb-1 block">Employee</Label>
            <Select value={empFilter} onValueChange={setEmpFilter}>
              <SelectTrigger className="w-48 bg-background" data-testid="select-bonus-emp-filter">
                <SelectValue placeholder="All employees" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Employees</SelectItem>
                {employees.map((e) => (
                  <SelectItem key={e.id} value={String(e.id)}>
                    {e.firstName} {e.lastName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="bg-background" data-testid="button-bonus-columns">
                  <Columns3 className="mr-2 h-4 w-4" />
                  Columns
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
                <DropdownMenuCheckboxItem checked disabled>
                  Employee Name
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem checked disabled>
                  Date
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={visibleColumns.amount}
                  onCheckedChange={(value) => setVisibleColumns((c) => ({ ...c, amount: value === true }))}
                >
                  Amount
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={visibleColumns.notes}
                  onCheckedChange={(value) => setVisibleColumns((c) => ({ ...c, notes: value === true }))}
                >
                  Notes
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="outline"
              className={showFilters ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40" : "bg-background"}
              onClick={() => setShowFilters((open) => !open)}
              aria-expanded={showFilters}
              data-testid="button-bonus-filters"
            >
              <Filter className="mr-2 h-4 w-4" />
              Filters
            </Button>
            <ExportButton
              kind="csv"
              className="bg-background"
              onClick={exportBonusesCsv}
              disabled={isLoading || shownBonuses.length === 0}
              data-testid="button-bonus-export"
            />
            {recordChanges.canCreate("POST", "/api/factory/employee-bonuses") && (
              <Button
                onClick={() => setAddOpen(true)}
                className="bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-500"
                data-testid="button-add-bonus"
              >
                <Plus className="h-4 w-4 mr-2" /> Add Bonus
              </Button>
            )}
          </div>
        </div>
        {showFilters && (
          <div className="grid gap-3 rounded-xl border border-border/70 bg-muted/30 p-3 sm:grid-cols-[minmax(180px,1fr)_auto_auto] sm:items-end">
            <div>
              <Label htmlFor="bonus-search" className="mb-1.5 block text-xs text-muted-foreground">
                Name or notes
              </Label>
              <SearchField
                id="bonus-search"
                value={search}
                onValueChange={setSearch}
                placeholder="Search bonuses..."
                data-testid="input-bonus-search"
              />
            </div>
            <div>
              <Label className="mb-1.5 block text-xs text-muted-foreground">Period</Label>
              <PeriodFilter
                value={{
                  fromDate: startDate,
                  toDate: endDate,
                  preset: startDate || endDate ? "custom" : "all_time",
                }}
                onChange={(v) => {
                  setStartDate(v.fromDate);
                  setEndDate(v.toDate);
                }}
                data-testid="bonus-period-filter"
              />
            </div>
            <Button
              variant="ghost"
              onClick={() => {
                setSearch("");
                setStartDate("");
                setEndDate("");
              }}
            >
              Clear
            </Button>
          </div>
        )}

        {!isLoading && (
          <div
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50/90 px-4 py-3 dark:border-emerald-800/80 dark:bg-emerald-950/35"
            data-testid="bonus-total-banner"
          >
            <Gift className="h-4 w-4 text-emerald-600 shrink-0" />
            <span className="text-sm font-medium text-emerald-800 dark:text-emerald-200">Total bonuses shown</span>
            <strong className="text-lg font-bold tabular-nums text-emerald-700 dark:text-emerald-300">
              {fmt(totalBonuses)}
            </strong>
          </div>
        )}

        {isLoading ? (
          <div className="space-y-2">
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : shownBonuses.length === 0 ? (
          <Card className="border-dashed bg-muted/20">
            <CardContent className="py-12 text-center text-muted-foreground">
              <Gift className="h-10 w-10 mx-auto mb-3 opacity-40" />
              <p>{bonuses.length > 0 ? "No bonuses match these filters." : "No bonuses recorded yet."}</p>
            </CardContent>
          </Card>
        ) : (
          <FactoryEmployeeBonusesTabSectionContent
            recordChanges={recordChanges}
            setDeleteConfirm={setDeleteConfirm}
            shownBonuses={shownBonuses}
            visibleColumns={visibleColumns}
          />
        )}
      </div>
    </section>
  );
}
