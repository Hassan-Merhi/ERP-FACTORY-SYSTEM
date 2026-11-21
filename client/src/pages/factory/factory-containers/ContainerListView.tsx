import { Container, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/page-state";
import { DataTableToolbar } from "@/components/DataTableToolbar";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber } from "@/lib/formatNumber";
import { RowsExportMenu } from "@/components/export/RowsExportMenu";
import { getContainerStatusLabel } from "./otwHelpers";
import { containerTotalValue, type ContainerListViewProps } from "./ContainerListViewHelpers";
import { useContainerListViewState } from "./useContainerListViewState";
import { ContainerListViewTableBody } from "./ContainerListViewTableBody";

export function ContainerListView({
  containers,
  filteredContainers,
  searchQuery,
  setSearchQuery,
  statusFilter,
  setStatusFilter,
  hasActiveFilters,
  onResetFilters,
  expandedSuppliers,
  setExpandedSuppliers,
  selectedIds,
  setSelectedIds,
  onView,
  onEdit,
  onDelete,
  onPostOffload,
  onReverseOffload,
  onNavigateOffload,
}: ContainerListViewProps) {
  const { recordChanges, recordChangeReason, toggleSupplier, groups } = useContainerListViewState({
    filteredContainers,
    setExpandedSuppliers,
  });

  return (
    <section
      className="overflow-hidden rounded-2xl border border-border/70 bg-card/95 shadow-sm dark:border-blue-200/10 dark:bg-slate-900/60"
      aria-label="All factory containers"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 bg-gradient-to-r from-blue-500/5 via-background/40 to-violet-500/5 px-4 py-4 sm:px-5">
        <div className="flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-300">
            <Container className="h-5 w-5" />
          </span>
          <span className="text-sm font-semibold tracking-tight sm:text-base">
            Containers ({filteredContainers?.length || 0}
            {filteredContainers?.length !== containers?.length ? ` of ${containers?.length}` : ""})
          </span>
        </div>
        <DataTableToolbar
          search={searchQuery}
          onSearchChange={setSearchQuery}
          searchPlaceholder="Search containers..."
          searchTestId="input-search-containers"
          mobileFilters
          filterLabel="Container filters"
          activeFilterCount={statusFilter !== "all" ? 1 : 0}
          onResetFilters={onResetFilters}
          className="mb-0"
          filters={
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger
                className="w-40 rounded-lg border-border/70 bg-background/80 shadow-sm"
                data-testid="select-filter-status"
              >
                <SelectValue placeholder="All Statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="PENDING">Pending</SelectItem>
                <SelectItem value="IN_TRANSIT">In Transit</SelectItem>
                <SelectItem value="AVAILABLE">Available</SelectItem>
                <SelectItem value="OFFLOADED">Offloaded</SelectItem>
                <SelectItem value="HAS_WEIGHT">Has Weight</SelectItem>
                <SelectItem value="NO_WEIGHT">No Weight</SelectItem>
              </SelectContent>
            </Select>
          }
          actions={
            <>
              {hasActiveFilters && (
                <Button variant="outline" type="button" onClick={onResetFilters} data-testid="button-reset-filters">
                  <RotateCcw className="mr-2 h-4 w-4" />
                  Reset filters
                </Button>
              )}
              <RowsExportMenu
                title="Factory Containers"
                rows={groups.flatMap((group) => group.containers)}
                columns={[
                  { header: "Supplier", value: (c) => c.supplierName || "No Supplier" },
                  { header: "Container #", value: (c) => c.containerNumber },
                  {
                    header: "Commission",
                    value: (c) =>
                      parseFloat(c.commissionAmount || "0") > 0
                        ? `${c.commissionCurrencyCode || "USD"} ${formatNumber(parseFloat(c.commissionAmount || "0"))}`
                        : null,
                  },
                  {
                    header: "Weight (kg)",
                    value: (c) => (parseFloat(c.totalKg || "0") > 0 ? parseFloat(c.totalKg || "0") : null),
                    type: "number",
                  },
                  { header: "Currency", value: (c) => c.currencyCode || "USD" },
                  {
                    header: "Total Value",
                    value: (c) => (containerTotalValue(c) > 0 ? containerTotalValue(c) : null),
                    type: "number",
                  },
                  { header: "Status", value: (c) => getContainerStatusLabel(c.status) },
                ]}
                resource="factory.containers"
                size="default"
                data-testid="button-export-factory-containers"
              />
            </>
          }
        />
      </div>

      <div data-horizontal-scroll="true" className="overflow-x-auto">
        {filteredContainers && filteredContainers.length > 0 ? (
          <Table mobileLayout="cards" wrapperClassName="overflow-visible rounded-none border-0">
            <TableHeader className="sticky top-0 z-30 bg-card dark:bg-slate-900">
              <TableRow className="border-b border-border/70 bg-blue-500/5 hover:bg-blue-500/5 dark:bg-slate-800/70 dark:hover:bg-slate-800/70">
                <TableHead className="w-10 py-2">
                  <Checkbox
                    checked={filteredContainers.length > 0 && filteredContainers.every((c) => selectedIds.has(c.id))}
                    onCheckedChange={(checked) => {
                      if (checked) setSelectedIds(() => new Set(filteredContainers.map((c) => c.id)));
                      else setSelectedIds(() => new Set());
                    }}
                    data-testid="checkbox-select-all"
                  />
                </TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                  Container #
                </TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                  Commission
                </TableHead>
                <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                  Weight (kg)
                </TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                  Total Value
                </TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                  Status
                </TableHead>
                <TableHead className="w-24 text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                  Actions
                </TableHead>
              </TableRow>
            </TableHeader>
            <ContainerListViewTableBody
              expandedSuppliers={expandedSuppliers}
              groups={groups}
              onDelete={onDelete}
              onEdit={onEdit}
              onNavigateOffload={onNavigateOffload}
              onPostOffload={onPostOffload}
              onReverseOffload={onReverseOffload}
              onView={onView}
              recordChangeReason={recordChangeReason}
              recordChanges={recordChanges}
              selectedIds={selectedIds}
              setSelectedIds={setSelectedIds}
              toggleSupplier={toggleSupplier}
            />
          </Table>
        ) : (
          <EmptyState
            icon={Container}
            title={containers && containers.length > 0 ? "No matching containers" : "No factory containers yet"}
            description={
              containers && containers.length > 0
                ? "Try adjusting your search or filter"
                : "Add your first container to start tracking arrivals"
            }
            className="rounded-none border-0"
          />
        )}
      </div>
    </section>
  );
}
