import { Plus, AlertCircle, Trash2, ArrowLeft, Container } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/PageHeader";
import { OtwSummaryView } from "./factory-containers/OtwSummaryView";
import { ContainerListView } from "./factory-containers/ContainerListView";
import { ContainerFormDialog } from "./factory-containers/ContainerFormDialog";
import { ContainerDetailDialog } from "./factory-containers/ContainerDetailDialog";
import { PostOffloadDialog } from "./factory-containers/PostOffloadDialog";
import { BulkDeleteDialog, SingleDeleteDialog, ReverseOffloadDialog } from "./factory-containers/ContainerDialogs";
import { useFactoryContainersState } from "./useFactoryContainersState";
import { FactoryContainersDialogSection } from "./FactoryContainersDialogSection";

export default function FactoryContainers() {
  const {
    bulkDeleteOpen,
    containers,
    createOpen,
    editingContainer,
    expandedSuppliers,
    fileInputRef,
    filteredContainers,
    fmtOtwKg,
    handleFileSelect,
    hasActiveFilters,
    importMutation,
    importOpen,
    importPreview,
    importResult,
    isLoading,
    ledgerAccounts,
    navigate,
    openEdit,
    openOtwGroups,
    otwContainers,
    otwGrandTotals,
    otwSupplierGroups,
    pendingDeleteId,
    postOffloadContainer,
    recordChanges,
    resetFilters,
    reversingContainer,
    searchQuery,
    selectedIds,
    setBulkDeleteOpen,
    setCreateOpen,
    setEditingContainer,
    setExpandedSuppliers,
    setFilter,
    setImportOpen,
    setImportPreview,
    setImportResult,
    setPendingDeleteId,
    setPostOffloadContainer,
    setReversingContainer,
    setSelectedIds,
    setViewContainer,
    setViewMode,
    statusFilter,
    suppliers,
    toggleOtwGroup,
    viewContainer,
    viewMode,
  } = useFactoryContainersState();

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-5 sm:space-y-6" data-testid="factory-containers-screen">
      <section className="relative overflow-hidden rounded-2xl border border-border/70 bg-gradient-to-br from-background via-background to-blue-500/5 p-4 shadow-sm dark:from-slate-950 dark:via-slate-950 dark:to-indigo-950/60 sm:p-6">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-20 -top-24 size-72 rounded-full bg-blue-500/10 blur-3xl dark:bg-indigo-500/15"
        />
        <div className="relative">
          <PageHeader
            title="Factory Containers"
            subtitle="Track incoming containers (separate from ERP containers)"
            backTarget="/factory/production-report"
            icon={
              <span className="flex size-11 items-center justify-center rounded-xl border border-violet-400/25 bg-gradient-to-br from-violet-500/20 to-blue-500/15 text-violet-600 shadow-sm dark:text-violet-300">
                <Container className="h-6 w-6" />
              </span>
            }
          >
            <div className="flex flex-wrap items-center gap-2">
              {selectedIds.size > 0 && recordChanges.allowed && (
                <Button
                  variant="destructive"
                  onClick={() => setBulkDeleteOpen(true)}
                  data-testid="button-delete-selected"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete Selected ({selectedIds.size})
                </Button>
              )}
              {viewMode === "summary" ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setViewMode("list")}
                  data-testid="button-view-list"
                  className="gap-2 rounded-lg border-border/80 bg-background/70 shadow-sm hover:border-blue-500/40 hover:bg-blue-500/5"
                >
                  <AlertCircle className="h-4 w-4" /> All Containers
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSelectedIds(new Set());
                    setViewMode("summary");
                  }}
                  data-testid="button-view-summary"
                  className="gap-2 rounded-lg border-border/80 bg-background/70 shadow-sm hover:border-blue-500/40 hover:bg-blue-500/5"
                >
                  <ArrowLeft className="h-4 w-4" /> Factory Containers
                </Button>
              )}
              {!recordChanges.isCreateOnly && (
                <Button
                  onClick={() => navigate("/factory/containers/new")}
                  data-testid="button-add-factory-container"
                  className="gap-2 rounded-lg bg-blue-600 text-white shadow-sm shadow-blue-700/20 hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-500"
                >
                  <Plus className="h-4 w-4" /> Add Container
                </Button>
              )}
            </div>
          </PageHeader>
        </div>
      </section>

      {viewMode === "summary" && (
        <OtwSummaryView
          otwContainers={otwContainers}
          otwSupplierGroups={otwSupplierGroups}
          otwGrandTotals={otwGrandTotals}
          openOtwGroups={openOtwGroups}
          toggleOtwGroup={toggleOtwGroup}
          fmtOtwKg={fmtOtwKg}
          onViewContainer={setViewContainer}
        />
      )}

      {viewMode === "list" && (
        <ContainerListView
          containers={containers}
          filteredContainers={filteredContainers}
          suppliers={suppliers}
          searchQuery={searchQuery}
          setSearchQuery={(next) => setFilter("searchQuery", next)}
          statusFilter={statusFilter}
          setStatusFilter={(next) => setFilter("statusFilter", next)}
          hasActiveFilters={hasActiveFilters}
          onResetFilters={resetFilters}
          expandedSuppliers={expandedSuppliers}
          setExpandedSuppliers={setExpandedSuppliers}
          selectedIds={selectedIds}
          setSelectedIds={setSelectedIds}
          onView={setViewContainer}
          onEdit={openEdit}
          onDelete={setPendingDeleteId}
          onPostOffload={setPostOffloadContainer}
          onReverseOffload={setReversingContainer}
          onNavigateOffload={() => navigate("/factory/raw-stock")}
        />
      )}

      {/* ── Dialogs ───────────────────────────────────────────────────────── */}
      <ContainerFormDialog
        open={createOpen || !!editingContainer}
        editingContainer={editingContainer}
        suppliers={suppliers}
        ledgerAccounts={ledgerAccounts}
        onClose={() => {
          setCreateOpen(false);
          setEditingContainer(null);
        }}
      />

      <ContainerDetailDialog
        container={viewContainer}
        suppliers={suppliers}
        ledgerAccounts={ledgerAccounts}
        onClose={() => setViewContainer(null)}
        onEdit={(c) => {
          setViewContainer(null);
          openEdit(c);
        }}
      />

      <PostOffloadDialog
        container={postOffloadContainer}
        ledgerAccounts={ledgerAccounts}
        onClose={() => setPostOffloadContainer(null)}
      />

      <BulkDeleteDialog
        open={bulkDeleteOpen}
        selectedIds={selectedIds}
        onClose={() => setBulkDeleteOpen(false)}
        onDeleted={() => setSelectedIds(new Set())}
      />

      <SingleDeleteDialog containerId={pendingDeleteId} onClose={() => setPendingDeleteId(null)} />

      <ReverseOffloadDialog container={reversingContainer} onClose={() => setReversingContainer(null)} />

      {/* ── Import Dialog ─────────────────────────────────────────────────── */}
      <FactoryContainersDialogSection
        fileInputRef={fileInputRef}
        handleFileSelect={handleFileSelect}
        importMutation={importMutation}
        importOpen={importOpen}
        importPreview={importPreview}
        importResult={importResult}
        setImportOpen={setImportOpen}
        setImportPreview={setImportPreview}
        setImportResult={setImportResult}
      />
    </div>
  );
}
