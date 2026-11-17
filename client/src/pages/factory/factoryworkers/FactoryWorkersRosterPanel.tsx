import { useState } from "react";
import {
  Users,
  UserX,
  UserCheck,
  Upload,
  Download,
  ChevronDown,
  Bus,
  Banknote,
  Info,
  WalletCards,
  Layers,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { downloadFromUrl } from "@/lib/exportFile";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TabsContent } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";

import type { useFactoryWorkersModel } from "./useFactoryWorkersModel";
import { formatUsd } from "@/lib/moneyDisplay";
import {
  PEOPLE_TABLE_HEAD_CLASS,
  PeopleEmptyRow,
  PeopleFilterButton,
  PeopleFilterChips,
  type PeopleFilterChip,
  PeopleFilterPanel,
  PeopleFilterSelect,
  PeopleKpiCards,
  PeopleRosterToolbar,
  PeopleRowActions,
  PersonNameCell,
  PersonStatusBadge,
} from "../people/PeopleRoster";
import { exportPeopleTablePdf, type PeopleExportColumn } from "../people/peopleExport";

const SALARY_RANGE_LABELS: Record<string, string> = {
  "0-500": "Under $500",
  "500-1000": "$500 – under $1,000",
  "1000-2000": "$1,000 – under $2,000",
  "2000-5000": "$2,000 – under $5,000",
  "5000+": "$5,000 and above",
};

interface FactoryWorkersModelProps {
  model: ReturnType<typeof useFactoryWorkersModel>;
  onOpenCategories?: () => void;
}

export function FactoryWorkersRosterPanel({ model, onOpenCategories }: FactoryWorkersModelProps) {
  const { toast } = useToast();
  const {
    setLocation,
    searchQuery,
    setSearchQuery,
    statusFilter,
    setStatusFilter,
    filtersOpen,
    setFiltersOpen,
    positionFilter,
    setPositionFilter,
    locationFilter,
    setLocationFilter,
    nationalityFilter,
    setNationalityFilter,
    salaryTypeFilter,
    setSalaryTypeFilter,
    salaryRangeFilter,
    setSalaryRangeFilter,
    transportFilter,
    setTransportFilter,
    advanceFilter,
    setAdvanceFilter,
    setCreateOpen,
    importLoading,
    fileInputRef,
    workers,
    isLoading,
    docCounts,
    amountDue,
    reactivateMutation,
    canChangeExistingRecords,
    canCreate,
    handleImportFile,
    resetForm,
    openEdit,
    openEndContract,
    uniquePositions,
    uniqueLocations,
    uniqueNationalities,
    uniqueSalaryTypes,
    activeFilterCount,
    clearAllFilters,
    filteredWorkers,
    activeCount,
    inactiveCount,
    handleExportSalaries,
    totalSalary,
    totalTransport,
    totalAdvances,
    totalRemainingToBePaid,
    showCategories,
  } = model;

  const [pdfBusy, setPdfBusy] = useState(false);
  const money = (amount: number) => formatUsd(amount, 0, 2);
  const kpiCards = [
    { label: "Total", value: String(workers?.length ?? 0), icon: Users },
    { label: "Active", value: String(activeCount), icon: UserCheck },
    { label: "Inactive", value: String(inactiveCount), icon: UserX },
    { label: "Total Salary", value: money(totalSalary), icon: Download },
    { label: "Transport", value: money(totalTransport), icon: Bus },
    { label: "Advances", value: money(totalAdvances), icon: Banknote },
    { label: "Total Remaining", value: formatUsd(totalRemainingToBePaid, 2), icon: WalletCards, emphasis: true },
  ];

  type WorkerRow = (typeof filteredWorkers)[number];
  // PDF carries the same columns as the salaries Excel, with the Due Today amounts shown on screen.
  const pdfColumns: PeopleExportColumn<WorkerRow>[] = [
    { header: "#", type: "integer", value: (_worker, index) => index + 1 },
    { header: "Code", value: (worker) => worker.employeeCode ?? "" },
    { header: "Name", value: (worker) => worker.fullName },
    { header: "Position", value: (worker) => worker.position ?? "" },
    { header: "Department", value: (worker) => worker.department ?? "" },
    { header: "Salary Type", value: (worker) => worker.salaryType || "Monthly" },
    { header: "Base Salary", type: "money", value: (worker) => Number(worker.baseSalary || 0) || 0 },
    {
      header: "Due Today",
      type: "money",
      value: (worker) => {
        const net = amountDue[worker.id]?.net;
        return typeof net === "number" && Number.isFinite(net) ? Math.max(0, net) : null;
      },
    },
  ];
  const exportPdf = async () => {
    setPdfBusy(true);
    try {
      const salaryTotal = filteredWorkers.reduce((sum, worker) => sum + (Number(worker.baseSalary || 0) || 0), 0);
      const dueTotal = filteredWorkers.reduce((sum, worker) => {
        const net = amountDue[worker.id]?.net;
        return sum + (typeof net === "number" && net > 0 ? net : 0);
      }, 0);
      await exportPeopleTablePdf({
        title: "Factory Workers — Salaries",
        fileStem: "workers salaries",
        columns: pdfColumns,
        rows: filteredWorkers,
        footer: [null, "", `Total Workers: ${filteredWorkers.length}`, "", "", "TOTAL", salaryTotal, dueTotal],
      });
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setPdfBusy(false);
    }
  };

  const filterChips = [
    positionFilter !== "all" && {
      key: "position",
      label: "Position",
      value: positionFilter,
      onRemove: () => setPositionFilter("all"),
    },
    locationFilter !== "all" && {
      key: "location",
      label: "Location",
      value: locationFilter,
      onRemove: () => setLocationFilter("all"),
    },
    nationalityFilter !== "all" && {
      key: "nationality",
      label: "Nationality",
      value: nationalityFilter,
      onRemove: () => setNationalityFilter("all"),
    },
    salaryTypeFilter !== "all" && {
      key: "salaryType",
      label: "Type",
      value: salaryTypeFilter,
      onRemove: () => setSalaryTypeFilter("all"),
    },
    salaryRangeFilter !== "all" && {
      key: "salaryRange",
      label: "Salary",
      value: SALARY_RANGE_LABELS[salaryRangeFilter] ?? salaryRangeFilter,
      onRemove: () => setSalaryRangeFilter("all"),
    },
    transportFilter !== "all" && {
      key: "transport",
      label: transportFilter === "has" ? "Has transport" : "No transport",
      onRemove: () => setTransportFilter("all"),
    },
    advanceFilter !== "all" && {
      key: "advance",
      label: advanceFilter === "has" ? "Has advance" : "No advance",
      onRemove: () => setAdvanceFilter("all"),
    },
  ].filter((chip): chip is PeopleFilterChip => Boolean(chip));

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
          <PeopleFilterPanel>
            <PeopleFilterSelect
              label="Position"
              value={positionFilter}
              onChange={setPositionFilter}
              allLabel="All positions"
              options={uniquePositions.map((value) => ({ value, label: value }))}
            />
            <PeopleFilterSelect
              label="Location"
              value={locationFilter}
              onChange={setLocationFilter}
              allLabel="All locations"
              options={uniqueLocations.map((value) => ({ value, label: value }))}
            />
            <PeopleFilterSelect
              label="Salary Type"
              value={salaryTypeFilter}
              onChange={setSalaryTypeFilter}
              allLabel="All types"
              options={uniqueSalaryTypes.map((value) => ({ value, label: value }))}
            />
            <PeopleFilterSelect
              label="Nationality"
              value={nationalityFilter}
              onChange={setNationalityFilter}
              allLabel="All nationalities"
              options={uniqueNationalities.map((value) => ({ value, label: value }))}
            />
            <PeopleFilterSelect
              label="Salary Range"
              value={salaryRangeFilter}
              onChange={setSalaryRangeFilter}
              allLabel="All ranges"
              options={Object.entries(SALARY_RANGE_LABELS).map(([value, label]) => ({ value, label }))}
            />
            <PeopleFilterSelect
              label="Transport"
              value={transportFilter}
              onChange={setTransportFilter}
              allLabel="All"
              options={[
                { value: "has", label: "Has transport allowance" },
                { value: "none", label: "No transport allowance" },
              ]}
            />
            <PeopleFilterSelect
              label="Advance"
              value={advanceFilter}
              onChange={setAdvanceFilter}
              allLabel="All"
              options={[
                { value: "has", label: "Has outstanding advance" },
                { value: "none", label: "No advance" },
              ]}
            />
          </PeopleFilterPanel>
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
            <TableHeader className="sticky top-0 z-30">
              <TableRow className="border-b border-border/70 bg-muted/65 hover:bg-muted/65">
                <TableHead className={`w-10 text-center pl-3 pr-1 ${PEOPLE_TABLE_HEAD_CLASS}`}>#</TableHead>
                <TableHead className={`w-[18%] ${PEOPLE_TABLE_HEAD_CLASS}`}>Worker</TableHead>
                <TableHead className={`w-[16%] ${PEOPLE_TABLE_HEAD_CLASS}`}>Position</TableHead>
                <TableHead className={`w-[11%] ${PEOPLE_TABLE_HEAD_CLASS}`}>Nationality</TableHead>
                <TableHead className={`w-[12%] ${PEOPLE_TABLE_HEAD_CLASS}`}>Location</TableHead>
                <TableHead className={`w-[10%] text-right ${PEOPLE_TABLE_HEAD_CLASS}`}>Salary</TableHead>
                <TableHead className={`w-[8%] text-right ${PEOPLE_TABLE_HEAD_CLASS}`}>Transport</TableHead>
                <TableHead className={`w-[8%] text-right ${PEOPLE_TABLE_HEAD_CLASS}`}>Advance</TableHead>
                <TableHead className={`w-[10%] text-right ${PEOPLE_TABLE_HEAD_CLASS}`}>Due Today</TableHead>
                <TableHead className={`w-[80px] ${PEOPLE_TABLE_HEAD_CLASS}`}>Status</TableHead>
                <TableHead className="w-[64px] py-2">
                  <span className="sr-only">Worker actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                [...Array(6)].map((_, i) => (
                  <TableRow key={i}>
                    <TableCell className="pl-3 pr-1">
                      <Skeleton className="h-4 w-5 mx-auto" />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Skeleton className="h-8 w-8 rounded-full shrink-0" />
                        <Skeleton className="h-4 w-32" />
                      </div>
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-20" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-16" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-16" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-14 ml-auto" />
                    </TableCell>
                    <TableCell></TableCell>
                    <TableCell></TableCell>
                    <TableCell></TableCell>
                    <TableCell>
                      <Skeleton className="h-5 w-12 rounded-full" />
                    </TableCell>
                    <TableCell></TableCell>
                  </TableRow>
                ))
              ) : filteredWorkers.length === 0 ? (
                <PeopleEmptyRow
                  colSpan={11}
                  title="No workers found"
                  hint={
                    searchQuery || statusFilter !== "All"
                      ? "Try adjusting your search or filters"
                      : "Add your first worker to get started"
                  }
                />
              ) : (
                filteredWorkers.map((worker, idx) => (
                  <TableRow
                    key={worker.id}
                    className="group cursor-pointer transition-colors hover:bg-primary/5"
                    onClick={() => setLocation(`/factory/workers/${worker.id}`)}
                    data-testid={`row-worker-${worker.id}`}
                  >
                    <TableCell className="py-3 pl-3 pr-1 text-center text-xs text-muted-foreground font-mono tabular-nums">
                      {idx + 1}
                    </TableCell>
                    <TableCell className="py-3">
                      <PersonNameCell
                        name={worker.fullName}
                        code={worker.employeeCode}
                        photoUrl={worker.photoUrl}
                        testIdSuffix={worker.id}
                        badge={
                          <span
                            className={`absolute bottom-0 right-0 h-2 w-2 rounded-full border-2 border-background ${(docCounts[worker.id] ?? 0) > 0 ? "bg-emerald-500" : "bg-red-400"}`}
                            title={
                              (docCounts[worker.id] ?? 0) > 0
                                ? `${docCounts[worker.id]} document(s) uploaded`
                                : "No documents uploaded"
                            }
                            data-testid={`dot-docs-${worker.id}`}
                          />
                        }
                      />
                    </TableCell>
                    <TableCell className="py-3 text-sm text-muted-foreground truncate">
                      {worker.position || <span className="text-muted-foreground/40">—</span>}
                    </TableCell>
                    <TableCell className="py-3 text-sm text-muted-foreground truncate">
                      {worker.nationality ? (
                        <span>{worker.nationality}</span>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </TableCell>
                    <TableCell className="py-3 text-sm text-muted-foreground truncate">
                      {worker.city || worker.country ? (
                        <span>{worker.city || worker.country}</span>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </TableCell>
                    <TableCell className="py-3 text-right font-mono text-sm tabular-nums text-muted-foreground">
                      {worker.baseSalary ? (
                        formatUsd(parseFloat(worker.baseSalary), 0, 3)
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </TableCell>
                    <TableCell className="py-3 text-right font-mono text-sm tabular-nums text-muted-foreground">
                      {parseFloat(worker.transportAllowance || "0") > 0 ? (
                        formatUsd(parseFloat(worker.transportAllowance || "0"), 0, 3)
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </TableCell>
                    <TableCell className="py-3 text-right font-mono text-sm">
                      {parseFloat(worker.pendingAdvanceBalance || "0") > 0 ? (
                        <span className="text-amber-600 dark:text-amber-400">
                          {formatUsd(parseFloat(worker.pendingAdvanceBalance || "0"), 0, 3)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </TableCell>

                    {/* ── Due Today ─────────────────────────────────── */}
                    <TableCell className="py-3 text-right font-mono text-sm" onClick={(e) => e.stopPropagation()}>
                      {(() => {
                        const due = amountDue[worker.id];
                        if (!due) return <span className="text-muted-foreground/40">—</span>;
                        const absenceDays = (due as typeof due & { absenceDays?: number }).absenceDays ?? 0;
                        const fmt = (n: number) =>
                          `${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                        const fmtDate = (s: string) =>
                          new Date(s + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
                        return (
                          <Popover>
                            <PopoverTrigger asChild>
                              <button
                                className={[
                                  "flex items-center gap-1 ml-auto rounded-sm px-1.5 py-0.5 transition-colors",
                                  "hover:bg-muted/60 cursor-pointer select-none",
                                  due.net > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground/50",
                                ].join(" ")}
                              >
                                {due.net > 0 ? fmt(due.net) : "Paid up"}
                                <Info className="h-3 w-3 opacity-50 shrink-0" />
                              </button>
                            </PopoverTrigger>
                            <PopoverContent className="w-64 p-3 text-sm" align="end" side="left">
                              <p className="font-semibold text-foreground mb-1">Due Today</p>
                              <p className="text-[11px] text-muted-foreground mb-3 leading-relaxed">
                                Period: {fmtDate(due.periodStart)} → {fmtDate(due.periodEnd)}
                                {due.lastPaidThrough && (
                                  <span className="block">Last paid through {fmtDate(due.lastPaidThrough)}</span>
                                )}
                              </p>
                              <div className="space-y-1.5">
                                <div className="flex justify-between">
                                  <span className="text-muted-foreground">Base salary</span>
                                  <span className="font-mono">{fmt(due.base)}</span>
                                </div>
                                {due.transport > 0 && (
                                  <div className="flex justify-between">
                                    <span className="text-muted-foreground">Transport</span>
                                    <span className="font-mono">+{fmt(due.transport)}</span>
                                  </div>
                                )}
                                {(due.absenceDeducted ?? 0) > 0 && (
                                  <div className="flex justify-between text-rose-600 dark:text-rose-400">
                                    <span>
                                      Absences deducted ({absenceDays} {absenceDays === 1 ? "day" : "days"})
                                    </span>
                                    <span className="font-mono">−{fmt(due.absenceDeducted)}</span>
                                  </div>
                                )}
                                {due.advanceDeducted > 0 && (
                                  <div className="flex justify-between text-amber-600 dark:text-amber-400">
                                    <span>Advance deducted</span>
                                    <span className="font-mono">−{fmt(due.advanceDeducted)}</span>
                                  </div>
                                )}
                                <div className="flex justify-between border-t pt-1.5 font-semibold">
                                  <span>Net due</span>
                                  <span
                                    className={`font-mono ${due.net > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}
                                  >
                                    {fmt(due.net)}
                                  </span>
                                </div>
                              </div>
                              <p className="text-[11px] text-muted-foreground/50 mt-2 leading-relaxed">
                                Calendar-day proration · Absences &amp; advances deducted
                              </p>
                            </PopoverContent>
                          </Popover>
                        );
                      })()}
                    </TableCell>

                    <TableCell className="py-3">
                      <PersonStatusBadge active={worker.active} data-testid={`badge-status-${worker.id}`} />
                    </TableCell>
                    <TableCell className="py-3">
                      {canChangeExistingRecords && (
                        <PeopleRowActions
                          active={worker.active}
                          onEdit={() => openEdit(worker)}
                          onEndContract={() => openEndContract(worker)}
                          onReactivate={() => reactivateMutation.mutate(worker.id)}
                          reactivating={reactivateMutation.isPending}
                          testIdSuffix={{
                            edit: `button-edit-worker-${worker.id}`,
                            end: `button-end-contract-${worker.id}`,
                            reactivate: `button-reactivate-${worker.id}`,
                          }}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </TabsContent>
    </>
  );
}
