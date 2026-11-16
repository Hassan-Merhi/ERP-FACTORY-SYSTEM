import {
  Plus,
  Search,
  Upload,
  Download,
  X,
  FileSpreadsheet,
  ChevronDown,
  SlidersHorizontal,
  Layers,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { downloadFromUrl } from "@/lib/exportFile";
import { Input } from "@/components/ui/input";
import { Table } from "@/components/ui/table";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TabsContent } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { useFactoryWorkersRosterPanelState, type FactoryWorkersModelProps } from "./useFactoryWorkersRosterPanelState";
import {
  FactoryWorkersRosterPanelTableBodySection,
  FactoryWorkersRosterPanelTableHeaderSection,
} from "./FactoryWorkersRosterPanelTableBodySection";
import { FactoryWorkersRosterPanelSection } from "./FactoryWorkersRosterPanelSection";

export function FactoryWorkersRosterPanel(props: FactoryWorkersModelProps) {
  const {
    activeFilterCount,
    advanceFilter,
    amountDue,
    canChangeExistingRecords,
    canCreate,
    clearAllFilters,
    docCounts,
    fileInputRef,
    filteredWorkers,
    filtersOpen,
    handleExportSalaries,
    handleImportFile,
    importLoading,
    isLoading,
    kpiCards,
    locationFilter,
    nationalityFilter,
    onOpenCategories,
    openEdit,
    openEndContract,
    positionFilter,
    reactivateMutation,
    resetForm,
    salaryRangeFilter,
    salaryTypeFilter,
    searchQuery,
    setAdvanceFilter,
    setCreateOpen,
    setFiltersOpen,
    setLocation,
    setLocationFilter,
    setNationalityFilter,
    setPositionFilter,
    setSalaryRangeFilter,
    setSalaryTypeFilter,
    setSearchQuery,
    setStatusFilter,
    setTransportFilter,
    showCategories,
    statusFilter,
    toast,
    transportFilter,
    uniqueLocations,
    uniqueNationalities,
    uniquePositions,
    uniqueSalaryTypes,
  } = useFactoryWorkersRosterPanelState(props);

  return (
    <>
      <TabsContent value="workers" className="mt-4 space-y-5">
        {/* Presentation only: amounts and eligibility remain calculated by the existing model. */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-7" data-testid="worker-kpi-cards">
          {isLoading
            ? Array.from({ length: 7 }).map((_, index) => <Skeleton key={index} className="h-[92px] rounded-xl" />)
            : kpiCards.map(({ label, value, icon: Icon, tone, iconTone, valueTone }) => (
                <div
                  key={label}
                  className={`min-w-0 rounded-xl border border-border/70 bg-gradient-to-br ${tone} p-3 shadow-sm transition-shadow hover:shadow-md sm:p-3.5`}
                >
                  <div className="flex min-w-0 items-start gap-2.5">
                    <div className={`shrink-0 rounded-lg p-2 ${iconTone}`}>
                      <Icon className="h-4 w-4" aria-hidden="true" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <span className="block text-xs text-muted-foreground">{label}</span>
                      <span
                        className={`block truncate pt-1 text-lg font-bold tracking-tight tabular-nums ${valueTone}`}
                        title={value}
                      >
                        {value}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
        </div>

        {/* Filter + actions row */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by name, code, position, nationality..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-10 rounded-lg border-border/70 bg-card/80 pl-9 shadow-sm focus-visible:ring-primary/40"
              data-testid="input-search"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-10 w-32 rounded-lg bg-card/80" data-testid="select-status-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="All">All</SelectItem>
              <SelectItem value="Active">Active</SelectItem>
              <SelectItem value="Inactive">Inactive</SelectItem>
            </SelectContent>
          </Select>

          {/* Filter toggle */}
          <Button
            variant={filtersOpen || activeFilterCount > 0 ? "default" : "outline"}
            size="sm"
            onClick={() => setFiltersOpen((o) => !o)}
            className="relative h-10 rounded-lg"
            data-testid="button-toggle-filters"
          >
            <SlidersHorizontal className="h-4 w-4 mr-1.5" />
            Filter
            {activeFilterCount > 0 && (
              <span className="ml-1.5 bg-background text-foreground text-[11px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                {activeFilterCount}
              </span>
            )}
          </Button>
          {activeFilterCount > 0 && (
            <button
              onClick={clearAllFilters}
              className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
            >
              Clear all
            </button>
          )}
          <input ref={fileInputRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleImportFile} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="h-10 rounded-lg bg-card/80" data-testid="button-actions-menu">
                Actions <ChevronDown className="h-4 w-4 ml-2" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52 rounded-xl border-border/80 p-1 shadow-xl">
              {showCategories && onOpenCategories && (
                <DropdownMenuItem
                  onClick={onOpenCategories}
                  className="rounded-lg bg-primary/10 font-medium text-primary focus:bg-primary/15 focus:text-primary"
                  data-testid="button-open-worker-categories"
                >
                  <Layers className="h-4 w-4" />
                  Categories
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={async () => {
                  try {
                    await downloadFromUrl("/api/factory/workers/template.xlsx", { fileName: "workers-template.xlsx" });
                  } catch (error) {
                    toast({
                      title: "Export failed",
                      description: error instanceof Error ? error.message : "Please try again.",
                      variant: "destructive",
                    });
                  }
                }}
                data-testid="button-download-template"
              >
                <Download className="h-4 w-4" />
                Template
              </DropdownMenuItem>
              {canChangeExistingRecords && (
                <DropdownMenuItem
                  onClick={() => fileInputRef.current?.click()}
                  disabled={importLoading}
                  data-testid="button-import-workers"
                >
                  <Upload className="h-4 w-4" />
                  {importLoading ? "Importing..." : "Import Excel"}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={handleExportSalaries}
                disabled={!filteredWorkers.length}
                data-testid="button-export-salaries"
              >
                <FileSpreadsheet className="h-4 w-4" />
                Export Excel (Salaries)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {canCreate("POST", "/api/factory/workers") && (
            <Button
              onClick={() => {
                resetForm();
                setCreateOpen(true);
              }}
              className="h-10 rounded-lg px-4 shadow-sm"
              data-testid="button-add-worker"
            >
              <Plus className="h-4 w-4 mr-2" />
              Add Worker
            </Button>
          )}
        </div>

        {/* ── Collapsible filter panel ─────────────────────────────── */}
        {filtersOpen && (
          <FactoryWorkersRosterPanelSection
            advanceFilter={advanceFilter}
            locationFilter={locationFilter}
            nationalityFilter={nationalityFilter}
            positionFilter={positionFilter}
            salaryRangeFilter={salaryRangeFilter}
            salaryTypeFilter={salaryTypeFilter}
            setAdvanceFilter={setAdvanceFilter}
            setLocationFilter={setLocationFilter}
            setNationalityFilter={setNationalityFilter}
            setPositionFilter={setPositionFilter}
            setSalaryRangeFilter={setSalaryRangeFilter}
            setSalaryTypeFilter={setSalaryTypeFilter}
            setTransportFilter={setTransportFilter}
            transportFilter={transportFilter}
            uniqueLocations={uniqueLocations}
            uniqueNationalities={uniqueNationalities}
            uniquePositions={uniquePositions}
            uniqueSalaryTypes={uniqueSalaryTypes}
          />
        )}

        {/* ── Active filter chips ───────────────────────────────────── */}
        {activeFilterCount > 0 && (
          <div className="flex flex-wrap gap-2">
            {positionFilter !== "all" && (
              <span className="inline-flex items-center gap-1 text-xs bg-primary/10 text-primary rounded-full px-2.5 py-1 font-medium">
                Position: {positionFilter}
                <button onClick={() => setPositionFilter("all")} className="hover:opacity-70">
                  <X className="h-3 w-3" />
                </button>
              </span>
            )}
            {locationFilter !== "all" && (
              <span className="inline-flex items-center gap-1 text-xs bg-primary/10 text-primary rounded-full px-2.5 py-1 font-medium">
                Location: {locationFilter}
                <button onClick={() => setLocationFilter("all")} className="hover:opacity-70">
                  <X className="h-3 w-3" />
                </button>
              </span>
            )}
            {nationalityFilter !== "all" && (
              <span className="inline-flex items-center gap-1 text-xs bg-primary/10 text-primary rounded-full px-2.5 py-1 font-medium">
                Nationality: {nationalityFilter}
                <button onClick={() => setNationalityFilter("all")} className="hover:opacity-70">
                  <X className="h-3 w-3" />
                </button>
              </span>
            )}
            {salaryTypeFilter !== "all" && (
              <span className="inline-flex items-center gap-1 text-xs bg-primary/10 text-primary rounded-full px-2.5 py-1 font-medium">
                Type: {salaryTypeFilter}
                <button onClick={() => setSalaryTypeFilter("all")} className="hover:opacity-70">
                  <X className="h-3 w-3" />
                </button>
              </span>
            )}
            {salaryRangeFilter !== "all" && (
              <span className="inline-flex items-center gap-1 text-xs bg-primary/10 text-primary rounded-full px-2.5 py-1 font-medium">
                {(
                  {
                    "0-500": "Salary: Under $500",
                    "500-1000": "Salary: $500 – under $1,000",
                    "1000-2000": "Salary: $1,000 – under $2,000",
                    "2000-5000": "Salary: $2,000 – under $5,000",
                    "5000+": "Salary: $5,000 and above",
                  } as Record<string, string>
                )[salaryRangeFilter] ?? `Salary: ${salaryRangeFilter}`}
                <button onClick={() => setSalaryRangeFilter("all")} className="hover:opacity-70">
                  <X className="h-3 w-3" />
                </button>
              </span>
            )}
            {transportFilter !== "all" && (
              <span className="inline-flex items-center gap-1 text-xs bg-primary/10 text-primary rounded-full px-2.5 py-1 font-medium">
                {transportFilter === "has" ? "Has transport" : "No transport"}
                <button onClick={() => setTransportFilter("all")} className="hover:opacity-70">
                  <X className="h-3 w-3" />
                </button>
              </span>
            )}
            {advanceFilter !== "all" && (
              <span className="inline-flex items-center gap-1 text-xs bg-primary/10 text-primary rounded-full px-2.5 py-1 font-medium">
                {advanceFilter === "has" ? "Has advance" : "No advance"}
                <button onClick={() => setAdvanceFilter("all")} className="hover:opacity-70">
                  <X className="h-3 w-3" />
                </button>
              </span>
            )}
            <span className="text-xs text-muted-foreground self-center">
              {filteredWorkers.length} result{filteredWorkers.length !== 1 ? "s" : ""}
            </span>
          </div>
        )}

        {/* Table */}
        <div
          data-horizontal-scroll="true"
          className="overflow-x-auto rounded-xl border border-border/70 bg-card/70 shadow-sm"
        >
          {/* min-w keeps the eight columns readable on tablets: the outer div scrolls sideways
              instead of table-fixed squeezing every header into one another. Phone cards reset it. */}
          <Table mobileLayout="cards" wrapperClassName="overflow-visible" className="w-full min-w-[64rem] table-fixed">
            <FactoryWorkersRosterPanelTableHeaderSection />
            <FactoryWorkersRosterPanelTableBodySection
              amountDue={amountDue}
              canChangeExistingRecords={canChangeExistingRecords}
              docCounts={docCounts}
              filteredWorkers={filteredWorkers}
              isLoading={isLoading}
              openEdit={openEdit}
              openEndContract={openEndContract}
              reactivateMutation={reactivateMutation}
              searchQuery={searchQuery}
              setLocation={setLocation}
              statusFilter={statusFilter}
            />
          </Table>
        </div>
      </TabsContent>
    </>
  );
}
