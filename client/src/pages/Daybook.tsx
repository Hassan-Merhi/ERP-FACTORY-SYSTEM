import {
  DaybookHeader,
  DaybookPage,
  DaybookResults,
  DaybookShowHiddenButton,
  DaybookTabs,
} from "@/components/daybook/DaybookFrame";
import { DAYBOOK_TABS } from "@/components/daybook/useDaybookTab";
import { PaginationBar } from "@/components/PaginationBar";
import { Button } from "@/components/ui/button";
import { DaybookOverview } from "./daybook/DaybookOverview";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, LayoutList, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DaybookUser } from "./daybook/types";
import { saveDaybookState } from "./daybook/state";
import { DaybookFilters } from "./daybook/DaybookFilters";
import { DaybookTable } from "./daybook/DaybookTable";
import { VoucherDetailsDialog } from "./daybook/VoucherDetailsDialog";
import { VoucherEditDialog } from "./daybook/VoucherEditDialog";
import { useDaybookModel } from "./DaybookModel";

export default function Daybook({ user }: { user?: DaybookUser | null } = {}) {
  const m = useDaybookModel({ user });

  return (
    <DaybookPage className="p-3 md:p-6">
      <DaybookHeader
        title="Daybook"
        subtitle={
          m.routineAccountingViewFiltered
            ? "Operational activity view"
            : "View all accounting transactions chronologically"
        }
        exportBusy={m.isExportingReport}
        exportOptions={[
          {
            id: "daybook-summary",
            label: "Summary",
            kind: "excel",
            onSelect: () => m.runDaybookExport(m.handleExportToExcel),
          },
          {
            id: "daybook-detail",
            label: "Detailed",
            kind: "excel",
            onSelect: () => m.runDaybookExport(m.handleExportDetailedToExcel),
          },
        ]}
      >
        {m.recordChanges.canCreate("POST", "/api/vouchers") && (
          <Button onClick={() => m.navigate(m.vouchersBase)} className="daybook-new-voucher gap-2">
            <Plus className="w-4 h-4" />
            New Voucher
          </Button>
        )}
      </DaybookHeader>

      <DaybookOverview stats={m.overviewStats} hideAmounts={m.hideAmounts} formatAmount={m.formatAmount} />

      <DaybookTabs value={m.activeDaybookTab} onValueChange={m.setActiveDaybookTab} tabs={DAYBOOK_TABS}>
        <DaybookFilters
          periodFilter={m.periodFilter}
          setPeriodFilter={m.setPeriodFilter}
          filters={m.filters}
          setFilters={m.setFilters}
          hasActiveFilters={m.hasActiveDaybookFilters}
          onResetFilters={m.resetDaybookFilters}
          onPrevDay={() => m.shiftDay(-1)}
          onNextDay={() => m.shiftDay(1)}
        />

        <DaybookResults
          description="All accounting vouchers and transactions"
          tools={
            <>
              <DaybookShowHiddenButton
                showHidden={m.showHidden}
                onToggle={() => m.setShowHidden(!m.showHidden)}
                hiddenCount={m.hiddenRowIds.size}
              />
              <div className="daybook-view-toggle" role="group" aria-label="Transaction layout">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    m.setViewMode("detailed");
                    saveDaybookState({ viewMode: "detailed" });
                  }}
                  className={cn("gap-1.5", m.viewMode === "detailed" && "daybook-toggle-active")}
                  data-testid="button-view-detailed"
                  data-remote-control-safe="true"
                  data-remote-control-action="toggle-view"
                >
                  <LayoutList className="w-4 h-4" />
                  Detailed
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    m.setViewMode("condensed");
                    saveDaybookState({ viewMode: "condensed" });
                  }}
                  className={cn("gap-1.5", m.viewMode === "condensed" && "daybook-toggle-active")}
                  data-testid="button-view-condensed"
                  data-remote-control-safe="true"
                  data-remote-control-action="toggle-view"
                >
                  <Layers className="w-4 h-4" />
                  Condensed
                </Button>
              </div>
            </>
          }
          footer={
            <PaginationBar
              page={m.voucherPageResponse?.page ?? m.voucherPage}
              totalPages={m.voucherPageResponse?.totalPages ?? 0}
              total={m.voucherPageResponse?.total ?? 0}
              pageSize={m.voucherPageResponse?.pageSize ?? m.VOUCHER_PAGE_SIZE}
              onPageChange={(nextPage) => {
                m.setVoucherPage(nextPage);
                m.setDaybookRowLimit(m.DAYBOOK_PAGE_SIZE);
              }}
              noun="vouchers"
            />
          }
        >
          <DaybookTable
            displayedRows={m.displayedRows}
            visibleRows={m.visibleRows}
            offloadAlphabetical={m.filters.voucherType === "Offload"}
            viewMode={m.viewMode}
            selectedRowId={m.selectedRowId}
            setSelectedRowId={m.setSelectedRowId}
            hiddenRowIds={m.hiddenRowIds}
            setHiddenRowIds={m.setHiddenRowIds}
            showHidden={m.showHidden}
            expandedVoucherId={m.expandedVoucherId}
            setExpandedVoucherId={m.setExpandedVoucherId}
            expandedCondensedGroups={m.expandedCondensedGroups}
            setExpandedCondensedGroups={m.setExpandedCondensedGroups}
            hideAmounts={m.hideAmounts}
            accountNameCache={m.accountNameCache}
            expandedLoading={m.expandedLoading}
            expandedEntries={m.expandedEntries}
            formatAmount={m.formatAmount}
            formatTransactionAmount={m.formatTransactionAmount}
            formatDisplayDate={m.formatDisplayDate}
            formatDisplayTime={m.formatDisplayTime}
            handleView={m.handleView}
            handleEdit={m.handleEdit}
            handleDelete={(v) => {
              m.setVoucherToDelete(v);
              m.setDeleteDialogOpen(true);
            }}
            canEdit={m.canEdit}
            canDelete={m.canDelete}
            linkedVoucherIds={m.linkedVoucherIds}
            daybookRowLimit={m.daybookRowLimit}
            setDaybookRowLimit={m.setDaybookRowLimit}
            DAYBOOK_PAGE_SIZE={m.DAYBOOK_PAGE_SIZE}
            navigate={m.navigate}
            isLoading={m.isLoading}
            errorMessage={m.daybookErrorMessage}
            onRetry={() => void m.refetchVouchers()}
          />
        </DaybookResults>

        <VoucherDetailsDialog
          open={m.viewDialogOpen}
          onOpenChange={m.setViewDialogOpen}
          selectedVoucher={m.selectedVoucher}
          viewEntriesLoading={m.viewEntriesLoading}
          viewVoucherEntries={m.viewVoucherEntries}
          isStockTransferVoucher={m.isStockTransferVoucher}
          voucherRevisions={m.voucherRevisions}
          revisionsLoading={m.revisionsLoading}
          revisionsError={m.revisionsError}
          revisionsErrorMessage={m.revisionsErrorDetail instanceof Error ? m.revisionsErrorDetail.message : undefined}
          retryVoucherRevisions={() => void m.retryVoucherRevisions()}
          formatAmount={m.formatAmount}
          formatDisplayDate={m.formatDisplayDate}
          formatDisplayTime={m.formatDisplayTime}
          cashAccountBalance={m.cashAccountBalance}
          entryBalances={m.entryBalances}
          purchaseOrderData={m.purchaseOrderData}
          poSupplierBalance={m.poSupplierBalance}
          selectedDialogRow={m.selectedDialogRow}
          setSelectedDialogRow={m.setSelectedDialogRow}
          viewProfitFilter={m.viewProfitFilter}
          setViewProfitFilter={m.setViewProfitFilter}
          user={user}
          handleEdit={m.handleEdit}
          canEdit={m.canEdit}
          navigate={m.navigate}
          employees={m.employees}
          ledgerAccounts={m.ledgerAccounts}
          bankAccounts={m.bankAccounts}
        />

        <VoucherEditDialog
          open={m.editDialogOpen}
          onOpenChange={m.setEditDialogOpen}
          voucherToEdit={m.voucherToEdit}
          entriesLoading={m.entriesLoading}
          editForm={m.editForm}
          editFields={m.editFields}
          editAppend={m.editAppend}
          editRemove={m.editRemove}
          handleSaveEdit={(d) => m.voucherToEdit && m.editMutation.mutate({ id: m.voucherToEdit.id, updates: d })}
          editMutationPending={m.editMutation.isPending}
          ledgerAccounts={m.ledgerAccounts}
          bankAccounts={m.bankAccounts}
          suppliers={m.suppliers}
          employees={m.employees}
          fixedAssets={m.fixedAssets}
          formatAmount={m.formatAmount}
        />
      </DaybookTabs>

      <AlertDialog open={m.deleteDialogOpen} onOpenChange={m.setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>
              {m.voucherToDelete && m.linkedVoucherIds.has(m.voucherToDelete.id)
                ? "This is an intercompany import voucher. Deleting it removes every original PO and import voucher in BOTH companies and their linked container. No reversal voucher is created. Received stock, payments, revised charges or other dependencies will block deletion."
                : "This action cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => m.voucherToDelete && m.deleteMutation.mutate(m.voucherToDelete.id)}
              className="bg-destructive"
              disabled={m.deleteMutation.isPending}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DaybookPage>
  );
}
