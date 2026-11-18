import { Upload, Download, ChevronDown, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { downloadFromUrl } from "@/lib/exportFile";
import { Table } from "@/components/ui/table";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TabsContent } from "@/components/ui/tabs";
import { PeopleFilterButton, PeopleFilterChips, PeopleKpiCards, PeopleRosterToolbar } from "../people/PeopleRoster";
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
    exportPdf,
    fileInputRef,
    filterChips,
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
    pdfBusy,
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
        <PeopleKpiCards cards={kpiCards} loading={isLoading} data-testid="worker-kpi-cards" />

        <PeopleRosterToolbar
          searchPlaceholder="Search by name, code, position, nationality..."
          search={searchQuery}
          onSearchChange={setSearchQuery}
          status={statusFilter}
          onStatusChange={setStatusFilter}
          exportOptions={[
            {
              id: "excel",
              label: "Excel",
              kind: "excel",
              onSelect: handleExportSalaries,
              disabled: !filteredWorkers.length,
              testId: "button-export-salaries",
            },
            {
              id: "pdf",
              label: "PDF",
              kind: "pdf",
              onSelect: exportPdf,
              disabled: !filteredWorkers.length,
              testId: "button-export-workers-pdf",
            },
          ]}
          exportBusy={pdfBusy}
          addLabel="Add Worker"
          onAdd={
            canCreate("POST", "/api/factory/workers")
              ? () => {
                  resetForm();
                  setCreateOpen(true);
                }
              : undefined
          }
          searchTestId="input-search"
          statusTestId="select-status-filter"
          addTestId="button-add-worker"
        >
          <PeopleFilterButton
            open={filtersOpen}
            onToggle={() => setFiltersOpen((open) => !open)}
            activeCount={activeFilterCount}
            onClear={clearAllFilters}
          />
          <input ref={fileInputRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleImportFile} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="h-10" data-testid="button-actions-menu">
                Actions <ChevronDown className="ml-2 h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {showCategories && onOpenCategories && (
                <DropdownMenuItem onClick={onOpenCategories} data-testid="button-open-worker-categories">
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
            </DropdownMenuContent>
          </DropdownMenu>
        </PeopleRosterToolbar>

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

        <PeopleFilterChips chips={filterChips} resultCount={filteredWorkers.length} />

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
