import { Button } from "@/components/ui/button";
import { ArrowLeft, ArrowRight } from "lucide-react";

import { DocumentsModal } from "./factoryshippingcontainers/components/DocumentsModal";
import { WhatsAppModal } from "./factoryshippingcontainers/components/WhatsAppModal";
import { ShippingAvailabilityTable } from "./factoryshippingcontainers/components/ShippingAvailabilityTable";
import { ScheduledContainersTable } from "./factoryshippingcontainers/components/ScheduledContainersTable";
import { FilterPanel } from "./factoryshippingcontainers/components/FilterPanel";
import { ShippingToolbar } from "./factoryshippingcontainers/components/ShippingToolbar";
import { ShippingListExport } from "./factoryshippingcontainers/components/ShippingListExport";
import { DoneContainersSection } from "./factoryshippingcontainers/components/DoneContainersSection";
import { ShippingConfirmDialogs } from "./factoryshippingcontainers/components/ShippingConfirmDialogs";
import { ShippingDashboardOverview } from "./factoryshippingcontainers/components/ShippingDashboardOverview";
import { ShippingStatusChips } from "./factoryshippingcontainers/components/ShippingStatusChips";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { isExistingRecordReadOnlyRole } from "@shared/createOnlyRolePolicy";
import { useFactoryShippingContainersModel } from "./FactoryShippingContainersModel";
import { FactoryShippingContainersTable } from "./FactoryShippingContainersTable";

export default function FactoryShippingContainers() {
  const m = useFactoryShippingContainersModel();

  return (
    <>
      <div className="space-y-3" data-testid="shipping-compact-dashboard">
        <ShippingDashboardOverview
          rows={m.scopedRows}
          today={m.today}
          dateFrom={m.dateFrom}
          dateTo={m.dateTo}
          onDateFrom={m.setDateFrom}
          onDateTo={m.setDateTo}
          onOpenInvoicing={() => m.navigate("/factory/sales/new")}
          allowNewOrder={Boolean(m.me?.role && !isExistingRecordReadOnlyRole(m.me.role))}
          showOrderValue={m.colVis.containerCost}
        />
        <ShippingToolbar
          search={m.search}
          onSearch={m.setSearch}
          filterStatus={m.filterStatus}
          onFilterStatus={(value) => {
            m.setFilterStatus(value);
            m.setQuickMode("all");
          }}
          destinationFilter={m.destinationFilter}
          onDestinationFilter={m.setDestinationFilter}
          destinations={m.destinations}
          shippingCompanyFilter={m.shippingCompanyFilter}
          onShippingCompanyFilter={m.setShippingCompanyFilter}
          shippingCompanies={m.shippingCompanies}
          showFilters={m.showFilters}
          onToggleFilters={() => m.setShowFilters((v) => !v)}
          hasActiveFilters={m.hasActiveFilters}
          colVis={m.colVis}
          toggleCol={m.toggleCol}
          showAllCols={m.showAllCols}
          hiddenCount={m.hiddenCount}
          exportMenu={
            <ShippingListExport rows={m.filtered} colVis={m.colVis} period={{ from: m.dateFrom, to: m.dateTo }} />
          }
        />

        {m.showFilters && (
          <FilterPanel
            filterDocs={m.filterDocs}
            setFilterDocs={(value) => {
              m.setFilterDocs(value);
              m.setQuickMode("all");
            }}
            filterStatus={m.filterStatus}
            setFilterStatus={(value) => {
              m.setFilterStatus(value);
              m.setQuickMode("all");
            }}
          />
        )}

        <ShippingStatusChips
          rows={m.scopedRows}
          today={m.today}
          filterStatus={m.filterStatus}
          filterDocs={m.filterDocs}
          quickMode={m.quickMode}
          onSelect={m.applyQuickSelection}
        />
        <p className="px-1 text-[11px] text-muted-foreground">
          Select Container #, Destination, ETA, Shipping Co., Note, Anything or Arrived to edit inline.
        </p>

        {/* ── Main Table ── */}
        <div className="overflow-hidden rounded-xl border border-border/70 bg-card shadow-sm dark:bg-card">
          <FactoryShippingContainersTable m={m} />
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 px-3 py-2 text-xs text-muted-foreground">
            <span>
              Showing {m.filtered.length === 0 ? 0 : (m.currentPage - 1) * m.pageSize + 1}–
              {Math.min(m.currentPage * m.pageSize, m.filtered.length)} of {m.filtered.length} orders
            </span>
            <div className="flex items-center gap-1.5">
              <Button
                size="icon"
                variant="outline"
                className="h-8 w-8 rounded-lg"
                disabled={m.currentPage <= 1}
                onClick={() => m.setPage((value) => Math.max(1, value - 1))}
                aria-label="Previous shipping page"
                data-testid="shipping-prev-page"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
              </Button>
              <span className="min-w-14 text-center tabular-nums">
                {m.currentPage} / {m.pageCount}
              </span>
              <Button
                size="icon"
                variant="outline"
                className="h-8 w-8 rounded-lg"
                disabled={m.currentPage >= m.pageCount}
                onClick={() => m.setPage((value) => Math.min(m.pageCount, value + 1))}
                aria-label="Next shipping page"
                data-testid="shipping-next-page"
              >
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
              <Select value={String(m.pageSize)} onValueChange={(value) => m.setPageSize(Number(value))}>
                <SelectTrigger
                  className="h-8 w-[98px] rounded-lg text-xs"
                  aria-label="Shipping rows per page"
                  data-testid="shipping-page-size"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="10">10 / page</SelectItem>
                  <SelectItem value="20">20 / page</SelectItem>
                  <SelectItem value="50">50 / page</SelectItem>
                  <SelectItem value="100">100 / page</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {/* ── Scheduled Containers and Container Availability ── */}
        <ScheduledContainersTable />
        <ShippingAvailabilityTable />

        {/* ── Done / Hidden Containers ── */}
        <DoneContainersSection
          expanded={m.doneExpanded}
          onToggleExpanded={() => m.setDoneExpanded((v) => !v)}
          done={m.done}
          doneTotal={m.doneTotal}
          doneTotalPages={m.doneTotalPages}
          donePage={m.donePage}
          onDonePage={m.setDonePage}
          restorePending={m.restoreMutation.isPending}
          onView={m.setDocsRowId}
          onRestore={(id) => m.restoreMutation.mutate(id)}
          onDelete={m.setPendingDeleteId}
        />
      </div>

      {/* Hidden file input for shipping invoice upload */}
      <input
        ref={m.shippingInvoiceInputRef}
        type="file"
        accept="application/pdf,image/*"
        className="hidden"
        onChange={m.handleShippingInvoiceFileChange}
        data-testid="input-shipping-invoice-file"
      />

      {/* ── Dialogs ── */}
      <DocumentsModal
        open={!!m.docsRowId}
        rowId={m.docsRowId}
        invoiceNumber={m.docsRow?.invoiceNumber || ""}
        onClose={() => m.setDocsRowId(null)}
      />

      <WhatsAppModal
        open={!!m.waRowId}
        rowId={m.waRowId}
        onClose={() => m.setWaRowId(null)}
        onMarkDone={(id, markWaSent) => m.doneMutation.mutate({ id, markWaSent })}
      />

      <ShippingConfirmDialogs
        pendingDeleteId={m.pendingDeleteId}
        onCancelDelete={() => m.setPendingDeleteId(null)}
        onConfirmDelete={(id) => {
          m.deleteRowMutation.mutate(id);
          m.setPendingDeleteId(null);
        }}
        pendingDoneId={m.pendingDoneId}
        onCancelDone={() => m.setPendingDoneId(null)}
        onConfirmDone={(id) => {
          m.doneMutation.mutate({ id });
          m.setPendingDoneId(null);
        }}
      />
    </>
  );
}
