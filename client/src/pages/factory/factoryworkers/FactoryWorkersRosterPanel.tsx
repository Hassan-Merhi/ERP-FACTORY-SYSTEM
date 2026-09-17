import {
  Plus,
  Pencil,
  Search,
  Users,
  UserX,
  UserCheck,
  Upload,
  Download,
  X,
  FileDown,
  ChevronDown,
  Bus,
  Banknote,
  Info,
  SlidersHorizontal,
  WalletCards,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TabsContent } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";

import { getAvatarColor, getInitials } from "./utils";
import type { useFactoryWorkersModel } from "./useFactoryWorkersModel";

interface FactoryWorkersModelProps {
  model: ReturnType<typeof useFactoryWorkersModel>;
}

export function FactoryWorkersRosterPanel({ model }: FactoryWorkersModelProps) {
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
  } = model;

  return (
    <>
      <TabsContent value="workers" className="mt-4 space-y-5">
        {/* Stats pills */}
        <div className="flex flex-wrap gap-3">
          {isLoading ? (
            <>
              <Skeleton className="h-10 w-36 rounded-lg" />
              <Skeleton className="h-10 w-32 rounded-lg" />
              <Skeleton className="h-10 w-32 rounded-lg" />
              <Skeleton className="h-10 w-44 rounded-lg" />
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-4 py-2 text-sm">
                <Users className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Total</span>
                <span className="font-semibold">{workers?.length ?? 0}</span>
              </div>
              <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-4 py-2 text-sm">
                <UserCheck className="h-4 w-4 text-emerald-500" />
                <span className="text-muted-foreground">Active</span>
                <span className="font-semibold">{activeCount}</span>
              </div>
              <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-4 py-2 text-sm">
                <UserX className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Inactive</span>
                <span className="font-semibold">{inactiveCount}</span>
              </div>
              <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-4 py-2 text-sm">
                <Download className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Total Salary</span>
                <span className="font-semibold font-mono">${totalSalary.toLocaleString()}</span>
              </div>
              <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-4 py-2 text-sm">
                <Bus className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Transport</span>
                <span className="font-semibold font-mono">${totalTransport.toLocaleString()}</span>
              </div>
              <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-4 py-2 text-sm">
                <Banknote className="h-4 w-4 text-amber-500" />
                <span className="text-muted-foreground">Advances</span>
                <span className="font-semibold font-mono">${totalAdvances.toLocaleString()}</span>
              </div>
              <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-4 py-2 text-sm">
                <WalletCards className="h-4 w-4 text-violet-500" />
                <span className="text-muted-foreground">Total Remaining</span>
                <span className="font-semibold font-mono text-violet-600 dark:text-violet-400">
                  $
                  {totalRemainingToBePaid.toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </span>
              </div>
            </>
          )}
        </div>

        {/* Filter + actions row */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by name, code, position, nationality..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
              data-testid="input-search"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-32" data-testid="select-status-filter">
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
            className="relative"
            data-testid="button-toggle-filters"
          >
            <SlidersHorizontal className="h-4 w-4 mr-1.5" />
            Filter
            {activeFilterCount > 0 && (
              <span className="ml-1.5 bg-background text-foreground text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
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
              <Button variant="outline" data-testid="button-actions-menu">
                Actions <ChevronDown className="h-4 w-4 ml-2" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem
                onClick={() => window.open("/api/factory/workers/template.xlsx", "_blank")}
                data-testid="button-download-template"
              >
                <Download className="h-4 w-4" />
                Template
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => fileInputRef.current?.click()}
                disabled={importLoading}
                data-testid="button-import-workers"
              >
                <Upload className="h-4 w-4" />
                {importLoading ? "Importing..." : "Import Excel"}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={handleExportSalaries}
                disabled={!filteredWorkers.length}
                data-testid="button-export-salaries"
              >
                <FileDown className="h-4 w-4" />
                Export Salaries
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            onClick={() => {
              resetForm();
              setCreateOpen(true);
            }}
            data-testid="button-add-worker"
          >
            <Plus className="h-4 w-4 mr-2" />
            Add Worker
          </Button>
        </div>

        {/* ── Collapsible filter panel ─────────────────────────────── */}
        {filtersOpen && (
          <div className="rounded-xl border bg-muted/30 p-4 flex flex-wrap gap-4">
            {/* Position */}
            <div className="flex flex-col gap-1 min-w-[150px]">
              <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Position
              </label>
              <Select value={positionFilter} onValueChange={setPositionFilter}>
                <SelectTrigger className="h-8 text-sm bg-background">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All positions</SelectItem>
                  {uniquePositions.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Location */}
            <div className="flex flex-col gap-1 min-w-[150px]">
              <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Location
              </label>
              <Select value={locationFilter} onValueChange={setLocationFilter}>
                <SelectTrigger className="h-8 text-sm bg-background">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All locations</SelectItem>
                  {uniqueLocations.map((l) => (
                    <SelectItem key={l} value={l}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Salary type */}
            <div className="flex flex-col gap-1 min-w-[150px]">
              <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Salary Type
              </label>
              <Select value={salaryTypeFilter} onValueChange={setSalaryTypeFilter}>
                <SelectTrigger className="h-8 text-sm bg-background">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  {uniqueSalaryTypes.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Nationality */}
            <div className="flex flex-col gap-1 min-w-[150px]">
              <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Nationality
              </label>
              <Select value={nationalityFilter} onValueChange={setNationalityFilter}>
                <SelectTrigger className="h-8 text-sm bg-background">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All nationalities</SelectItem>
                  {uniqueNationalities.map((n) => (
                    <SelectItem key={n} value={n}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Salary range */}
            <div className="flex flex-col gap-1 min-w-[160px]">
              <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Salary Range
              </label>
              <Select value={salaryRangeFilter} onValueChange={setSalaryRangeFilter}>
                <SelectTrigger className="h-8 text-sm bg-background">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All ranges</SelectItem>
                  <SelectItem value="0-500">Under $500</SelectItem>
                  <SelectItem value="500-1000">$500 – under $1,000</SelectItem>
                  <SelectItem value="1000-2000">$1,000 – under $2,000</SelectItem>
                  <SelectItem value="2000-5000">$2,000 – under $5,000</SelectItem>
                  <SelectItem value="5000+">$5,000 and above</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Transport */}
            <div className="flex flex-col gap-1 min-w-[150px]">
              <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Transport
              </label>
              <Select value={transportFilter} onValueChange={setTransportFilter}>
                <SelectTrigger className="h-8 text-sm bg-background">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="has">Has transport allowance</SelectItem>
                  <SelectItem value="none">No transport allowance</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Advance status */}
            <div className="flex flex-col gap-1 min-w-[150px]">
              <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Advance</label>
              <Select value={advanceFilter} onValueChange={setAdvanceFilter}>
                <SelectTrigger className="h-8 text-sm bg-background">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="has">Has outstanding advance</SelectItem>
                  <SelectItem value="none">No advance</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
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
        <div className="border rounded-xl overflow-auto max-h-[calc(100vh-220px)]">
          <Table wrapperClassName="overflow-visible" className="w-full table-fixed">
            <TableHeader className="sticky top-0 z-30">
              <TableRow className="bg-muted border-b-2 border-border/60 hover:bg-muted">
                <TableHead className="w-10 text-center text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2 pl-3 pr-1">
                  #
                </TableHead>
                <TableHead className="w-[18%] text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                  Worker
                </TableHead>
                <TableHead className="w-[16%] text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                  Position
                </TableHead>
                <TableHead className="w-[11%] text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                  Nationality
                </TableHead>
                <TableHead className="w-[12%] text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                  Location
                </TableHead>
                <TableHead className="w-[10%] text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                  Salary
                </TableHead>
                <TableHead className="w-[8%] text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                  Transport
                </TableHead>
                <TableHead className="w-[8%] text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                  Advance
                </TableHead>
                <TableHead className="w-[10%] text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                  Due Today
                </TableHead>
                <TableHead className="w-[80px] text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                  Status
                </TableHead>
                <TableHead className="w-[64px] py-2"></TableHead>
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
                <TableRow>
                  <TableCell colSpan={11}>
                    <div className="flex flex-col items-center gap-2 py-10 text-center">
                      <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                        <Users className="h-5 w-5 text-muted-foreground" />
                      </div>
                      <p className="text-sm font-medium" data-testid="text-empty">
                        No workers found
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {searchQuery || statusFilter !== "All"
                          ? "Try adjusting your search or filters"
                          : "Add your first worker to get started"}
                      </p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                filteredWorkers.map((worker, idx) => (
                  <TableRow
                    key={worker.id}
                    className="group cursor-pointer hover:bg-muted/40"
                    onClick={() => setLocation(`/factory/workers/${worker.id}`)}
                    data-testid={`row-worker-${worker.id}`}
                  >
                    <TableCell className="py-3 pl-3 pr-1 text-center text-xs text-muted-foreground font-mono tabular-nums">
                      {idx + 1}
                    </TableCell>
                    <TableCell className="py-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="relative shrink-0">
                          <Avatar className={`h-8 w-8 text-xs font-semibold ${getAvatarColor(worker.fullName)}`}>
                            {worker.photoUrl ? <AvatarImage src={worker.photoUrl} /> : null}
                            <AvatarFallback className={getAvatarColor(worker.fullName)}>
                              {getInitials(worker.fullName)}
                            </AvatarFallback>
                          </Avatar>
                          <span
                            className={`absolute bottom-0 right-0 h-2 w-2 rounded-full border-2 border-background ${(docCounts[worker.id] ?? 0) > 0 ? "bg-emerald-500" : "bg-red-400"}`}
                            title={
                              (docCounts[worker.id] ?? 0) > 0
                                ? `${docCounts[worker.id]} document(s) uploaded`
                                : "No documents uploaded"
                            }
                            data-testid={`dot-docs-${worker.id}`}
                          />
                        </div>
                        <div className="flex flex-col min-w-0">
                          {worker.employeeCode && (
                            <span
                              className="text-xs font-mono text-muted-foreground leading-tight"
                              data-testid={`text-code-${worker.id}`}
                            >
                              {worker.employeeCode}
                            </span>
                          )}
                          <span
                            className="font-medium text-sm leading-snug break-words"
                            data-testid={`text-name-${worker.id}`}
                          >
                            {worker.fullName}
                          </span>
                        </div>
                      </div>
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
                    <TableCell className="py-3 text-right font-mono text-sm text-muted-foreground">
                      {worker.baseSalary ? (
                        `$${parseFloat(worker.baseSalary).toLocaleString()}`
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </TableCell>
                    <TableCell className="py-3 text-right font-mono text-sm text-muted-foreground">
                      {parseFloat(worker.transportAllowance || "0") > 0 ? (
                        `$${parseFloat(worker.transportAllowance || "0").toLocaleString()}`
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </TableCell>
                    <TableCell className="py-3 text-right font-mono text-sm">
                      {parseFloat(worker.pendingAdvanceBalance || "0") > 0 ? (
                        <span className="text-amber-600 dark:text-amber-400">
                          ${parseFloat(worker.pendingAdvanceBalance || "0").toLocaleString()}
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
                                  "flex items-center gap-1 ml-auto rounded px-1.5 py-0.5 transition-colors",
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
                              <p className="text-[10px] text-muted-foreground/50 mt-2 leading-relaxed">
                                Calendar-day proration · Absences &amp; advances deducted
                              </p>
                            </PopoverContent>
                          </Popover>
                        );
                      })()}
                    </TableCell>

                    <TableCell className="py-3">
                      <Badge
                        variant="secondary"
                        className={`text-xs no-default-active-elevate ${
                          worker.active
                            ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
                            : "bg-muted text-muted-foreground"
                        }`}
                        data-testid={`badge-status-${worker.id}`}
                      >
                        {worker.active ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                    <TableCell className="py-3">
                      <div
                        className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => openEdit(worker)}
                          data-testid={`button-edit-worker-${worker.id}`}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        {worker.active ? (
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => openEndContract(worker)}
                            data-testid={`button-end-contract-${worker.id}`}
                          >
                            <UserX className="h-3.5 w-3.5 text-destructive" />
                          </Button>
                        ) : (
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => reactivateMutation.mutate(worker.id)}
                            disabled={reactivateMutation.isPending}
                            data-testid={`button-reactivate-${worker.id}`}
                          >
                            <UserCheck className="h-3.5 w-3.5 text-emerald-600" />
                          </Button>
                        )}
                      </div>
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
