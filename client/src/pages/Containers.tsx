import { useDateFormat } from "@/contexts/DateFormatContext";
import { useLocation } from "wouter";
import { Package, Truck, Check, MapPin } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
// Split-out hooks
import { useContainerQueries } from "./containers/useContainerQueries";
import { useContainerNumberEdit } from "./containers/useContainerNumberEdit";
import { useContainerImportExport } from "./containers/useContainerImportExport";
import { useContainerSyncAll } from "./containers/useContainerSyncAll";
// Split-out components
import { useContainerFilters } from "./containers/useContainerFilters";
import { ContainerFilters } from "./containers/ContainerFilters";
import { ActiveContainersTable } from "./containers/ActiveContainersTable";
import { ContainerToolbar } from "./containers/ContainerToolbar";
import { ContainerLoadingState } from "./containers/ContainerLoadingState";
import { ContainerSpView } from "./containers/ContainerSpView";
import { ContainerConfirmDialogs } from "./containers/ContainerConfirmDialogs";

export default function Containers() {
  const { formatDisplayDate } = useDateFormat();
  const { selectedCompany } = useCompany();
  const { formatAmount } = useCurrencyContext();
  const [, setLocation] = useLocation();

  const isSupplierPartner = selectedCompany?.companyType === "supplier_partner";
  const isFactory = selectedCompany?.companyType === "factory" || selectedCompany?.companyType === "factory_v2";
  const canSyncAllVouchers = selectedCompany?.companyType === "erp";

  const {
    allContainers,
    soldContainers,
    spContainersList,
    suppliers,
    isLoading,
    spContainersLoading,
    hideContainerCosts,
  } = useContainerQueries(selectedCompany, isSupplierPartner, isFactory);

  const {
    searchTerm,
    setSearchTerm,
    statusFilter,
    setStatusFilter,
    supplierFilter,
    setSupplierFilter,
    containers,
    clearFilters,
  } = useContainerFilters(allContainers, soldContainers);

  const getSupplierName = (supplierId: number) => {
    const supplier = suppliers.find((s) => s.id === supplierId);
    return supplier ? supplier.legalName : "Unknown";
  };

  const numberEdit = useContainerNumberEdit();
  const syncAll = useContainerSyncAll();
  const importExport = useContainerImportExport({
    containers,
    filteredOtwContainers: containers.filter((container) => container.status === "OTW"),
    getSupplierName,
    formatDisplayDate,
  });

  if (isLoading && !isSupplierPartner) {
    return <ContainerLoadingState />;
  }

  if (isSupplierPartner) {
    return (
      <ContainerSpView
        spContainersList={spContainersList}
        allContainers={allContainers}
        suppliers={suppliers}
        searchTerm={searchTerm}
        setSearchTerm={setSearchTerm}
        isSpLoading={spContainersLoading || isLoading}
        setLocation={setLocation}
        formatDisplayDate={formatDisplayDate}
      />
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <PageHeader title="Container Tracking" subtitle="Track containers and manage offloading">
        <ContainerToolbar
          onExportExcel={importExport.exportToExcel}
          onExportAllFull={importExport.exportAllContainersFull}
          onSyncAll={() => syncAll.setSyncAllConfirmOpen(true)}
          isSyncing={syncAll.syncAllMutation.isPending}
          showSyncAll={canSyncAllVouchers}
        />
      </PageHeader>

      {/* Stats bar */}
      {!isLoading && allContainers.length > 0 && (
        <div className="flex flex-wrap gap-3">
          <div className="flex items-center gap-2 bg-muted/60 rounded-lg px-3 py-2">
            <Package className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold" data-testid="text-total-containers">
              {allContainers.length.toLocaleString()}
            </span>
            <span className="text-xs text-muted-foreground">Containers</span>
          </div>
          {(() => {
            const otwCount = allContainers.filter((c) => c.status === "OTW").length;
            const arrivedCount = allContainers.filter((c) => c.status === "ARRIVED").length;
            const offloadedCount = allContainers.filter((c) => c.status === "OFFLOADED").length;
            return (
              <>
                {otwCount > 0 && (
                  <div className="flex items-center gap-2 bg-blue-500/10 rounded-lg px-3 py-2">
                    <Truck className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                    <span className="text-sm font-semibold text-blue-700 dark:text-blue-300">{otwCount}</span>
                    <span className="text-xs text-muted-foreground">OTW</span>
                  </div>
                )}
                {arrivedCount > 0 && (
                  <div className="flex items-center gap-2 bg-amber-500/10 rounded-lg px-3 py-2">
                    <MapPin className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                    <span className="text-sm font-semibold text-amber-700 dark:text-amber-300">{arrivedCount}</span>
                    <span className="text-xs text-muted-foreground">Arrived</span>
                  </div>
                )}
                {offloadedCount > 0 && (
                  <div className="flex items-center gap-2 bg-green-500/10 rounded-lg px-3 py-2">
                    <Check className="h-4 w-4 text-green-600 dark:text-green-400" />
                    <span className="text-sm font-semibold text-green-700 dark:text-green-300">{offloadedCount}</span>
                    <span className="text-xs text-muted-foreground">Offloaded</span>
                  </div>
                )}
              </>
            );
          })()}
          {!hideContainerCosts && (
            <div className="flex items-center gap-2 bg-primary/10 rounded-lg px-3 py-2">
              <span className="text-sm font-semibold font-mono text-primary" data-testid="text-total-amount">
                {formatAmount(
                  containers.reduce((sum, c) => {
                    const gTotal = parseFloat(c.grandTotal ?? "0");
                    return sum + (gTotal || parseFloat(c.itemsTotal ?? "0") || 0);
                  }, 0)
                )}
              </span>
              <span className="text-xs text-muted-foreground">total value</span>
            </div>
          )}
        </div>
      )}

      <ContainerFilters
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        statusFilter={statusFilter}
        onStatusChange={setStatusFilter}
        supplierFilter={supplierFilter}
        onSupplierFilterChange={setSupplierFilter}
        suppliers={suppliers}
        getSupplierName={getSupplierName}
        onClearFilters={clearFilters}
      />

      <ActiveContainersTable
        containers={containers}
        allContainers={allContainers}
        isLoading={isLoading}
        hideContainerCosts={hideContainerCosts}
        formatDisplayDate={formatDisplayDate}
        formatAmount={formatAmount}
        editingNumberId={numberEdit.editingNumberId}
        editingNumberValue={numberEdit.editingNumberValue}
        onEditNumberStart={(id, number) => {
          numberEdit.setEditingNumberId(id);
          numberEdit.setEditingNumberValue(number);
        }}
        onEditNumberChange={numberEdit.setEditingNumberValue}
        onEditNumberSave={(id, containerNumber) =>
          numberEdit.editContainerNumberMutation.mutate({ id, containerNumber })
        }
        onEditNumberCancel={() => {
          numberEdit.setEditingNumberId(null);
          numberEdit.setEditingNumberValue("");
        }}
        isEditNumberPending={numberEdit.editContainerNumberMutation.isPending}
        getSupplierName={getSupplierName}
      />

      <ContainerConfirmDialogs
        syncAllConfirmOpen={syncAll.syncAllConfirmOpen}
        onSyncAllConfirmOpenChange={syncAll.setSyncAllConfirmOpen}
        onSyncAllConfirm={() => syncAll.syncAllMutation.mutate()}
      />

      {/* Hidden file input for tracking import */}
      <input
        ref={importExport.fileInputRef}
        type="file"
        accept=".xlsx,.xls"
        className="hidden"
        onChange={importExport.handleFileImport}
      />
    </div>
  );
}
