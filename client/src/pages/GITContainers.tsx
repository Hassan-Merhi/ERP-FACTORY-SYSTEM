import { ChangeEvent } from "react";
import { Redirect } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Ship, AlertTriangle, Filter, ChevronDown, X } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { cn } from "@/lib/utils";
import { isBlockingQueryError } from "@/lib/abortError";
import { ContainerDrawer } from "./git-containers/ContainerDrawer";
import { ContainerTable } from "./git-containers/ContainerTable";
import { ContainerBulkActions } from "./git-containers/ContainerBulkActions";
import { FilterBar, countGitContainerFilters } from "./git-containers/FilterBar";
import { ErpFilterSheet } from "@/components/ui/erp-mobile-filters";
import { ImportResultBanner } from "./git-containers/ImportResultBanner";
import { useGITContainersState } from "./useGITContainersState";
import { GITContainersPopoverSection, GITContainersSection, GITContainersSection2 } from "./GITContainersSection";
import { SearchField } from "@/components/ui/search-field";

export default function GITContainers(props: { embedded?: boolean }) {
  const {
    agentFilters,
    agents,
    allCompanies,
    allContainers,
    allEtaDates,
    arrived,
    atPort,
    atSea,
    colVis,
    companies,
    companyFilter,
    containerFilters,
    containerNumbers,
    data,
    delayed,
    delayedFilter,
    docsFilter,
    drawerContainer,
    drawerOpen,
    embedded,
    error,
    etaFilter,
    fileInputRef,
    filteredContainers,
    freightFilter,
    hasContainersWithNoEta,
    importMutation,
    importResult,
    inTransit,
    isAllowed,
    isError,
    isLoading,
    isPhoneLayout,
    isProperties,
    isViewOnly,
    leftDar,
    locationFilters,
    locations,
    notesFilter,
    offloadOverdue,
    openDrawer,
    otwHiddenCount,
    printRef,
    refetch,
    restrictedToCurrentCompany,
    search,
    setAgentFilters,
    setAllCompanies,
    setCompanyFilter,
    setContainerFilters,
    setDelayedFilter,
    setDocsFilter,
    setDrawerOpen,
    setEtaFilter,
    setFreightFilter,
    setImportResult,
    setLocationFilters,
    setNotesFilter,
    setSearch,
    setShowFilters,
    setSortOrder,
    setSupplierFilters,
    setTransporterFilters,
    setTruckFilters,
    setWaSending,
    showFilters,
    sortOrder,
    supplierFilters,
    suppliers,
    toast,
    toggleOtwCol,
    totalCost,
    totalTransportDuty,
    transporterFilters,
    transporters,
    truckFilters,
    trucks,
    undoImportMutation,
    user,
    userLoading,
    waSending,
  } = useGITContainersState(props);

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    importMutation.mutate(file);
    e.target.value = "";
  }

  const gitFilterCount = countGitContainerFilters({
    companyFilter,
    containerFilters,
    supplierFilters,
    transporterFilters,
    agentFilters,
    truckFilters,
    locationFilters,
    docsFilter,
    delayedFilter,
    freightFilter,
    etaFilter,
    notesFilter,
    sortOrder,
  });

  const activeFilterChips: Array<{ key: string; label: string; clear: () => void }> = [];
  if (companyFilter !== "ALL")
    activeFilterChips.push({
      key: "company",
      label: `Company: ${companyFilter}`,
      clear: () => setCompanyFilter("ALL"),
    });
  const multiChip = (key: string, title: string, selected: string[], reset: () => void) => {
    if (selected.length)
      activeFilterChips.push({
        key,
        label: `${title}: ${selected.length === 1 ? selected[0] : `${selected.length} selected`}`,
        clear: reset,
      });
  };
  multiChip("container", "Container", containerFilters, () => setContainerFilters([]));
  multiChip("supplier", "Supplier", supplierFilters, () => setSupplierFilters([]));
  multiChip("transporter", "Transporter", transporterFilters, () => setTransporterFilters([]));
  multiChip("agent", "Agent", agentFilters, () => setAgentFilters([]));
  multiChip("truck", "Truck", truckFilters, () => setTruckFilters([]));
  multiChip("location", "Location", locationFilters, () => setLocationFilters([]));
  if (docsFilter !== "ALL")
    activeFilterChips.push({ key: "docs", label: `Docs: ${docsFilter}`, clear: () => setDocsFilter("ALL") });
  if (delayedFilter !== "ALL")
    activeFilterChips.push({
      key: "delayed",
      label: `Delayed: ${delayedFilter}`,
      clear: () => setDelayedFilter("ALL"),
    });
  if (freightFilter !== "ALL")
    activeFilterChips.push({
      key: "freight",
      label: `Freight: ${freightFilter}`,
      clear: () => setFreightFilter("ALL"),
    });
  if (etaFilter !== "ALL")
    activeFilterChips.push({ key: "eta", label: "ETA: Custom", clear: () => setEtaFilter("ALL") });
  if (notesFilter !== "ALL")
    activeFilterChips.push({ key: "notes", label: `Notes: ${notesFilter}`, clear: () => setNotesFilter("ALL") });
  if (sortOrder !== "DEFAULT")
    activeFilterChips.push({
      key: "sort",
      label: `Sort: ${sortOrder === "ETA_ASC" ? "Earliest ETA" : "Latest ETA"}`,
      clear: () => setSortOrder("DEFAULT"),
    });

  function clearFilters() {
    setCompanyFilter("ALL");
    setContainerFilters([]);
    setSupplierFilters([]);
    setTransporterFilters([]);
    setAgentFilters([]);
    setTruckFilters([]);
    setLocationFilters([]);
    setDocsFilter("ALL");
    setDelayedFilter("ALL");
    setFreightFilter("ALL");
    setEtaFilter("ALL");
    setNotesFilter("ALL");
    setSortOrder("DEFAULT");
    setSearch("");
  }

  async function sendToWhatsApp() {
    setWaSending(true);
    try {
      // Send no image payload — the server generates the PDF report itself,
      // avoiding the 2 MB Express JSON body limit that a base64 screenshot would exceed.
      await apiRequest("POST", "/api/git/send-containers-whatsapp", {});
      toast({ title: "Sent", description: "Container report sent to WhatsApp group." });
    } catch (error: unknown) {
      toast({
        title: "Failed to send",
        description: error instanceof Error ? error.message : "Unable to send the container report.",
        variant: "destructive",
      });
    } finally {
      setWaSending(false);
    }
  }

  if (userLoading)
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="space-y-3 w-full max-w-sm">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      </div>
    );
  if (!isAllowed) return <Redirect to="/" />;

  if (!user || isLoading) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        {!embedded && <PageHeader title="Containers OTW" subtitle="Active container logistics and tracking" />}
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-muted-foreground">Loading containers…</p>
        </div>
      </div>
    );
  }

  // A cancelled request never failed, and a failed refetch that left the last
  // page on screen does not warrant replacing it with an error screen.
  if (isBlockingQueryError(isError ? error : null, allContainers.length > 0)) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        {!embedded && <PageHeader title="Containers OTW" subtitle="Active container logistics and tracking" />}
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center space-y-2">
            <AlertTriangle className="h-8 w-8 text-red-500 mx-auto" />
            <p className="text-sm font-medium">Failed to load containers</p>
            <p className="text-xs text-muted-foreground">{error instanceof Error ? error.message : "Unknown error"}</p>
            <Button variant="outline" size="sm" onClick={() => void refetch()} data-testid="button-containers-retry">
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const sessionCompanyId = data?.mode === "single" && data.companyId ? data.companyId : null;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 min-h-0 overflow-hidden p-3 sm:p-4 flex flex-col gap-3">
        {!embedded && (
          <div className="shrink-0">
            <PageHeader
              title="Containers OTW"
              subtitle="Active container logistics and tracking"
              icon={<Ship className="h-5 w-5" aria-hidden="true" />}
            />
          </div>
        )}
        {/* ── Company Mode ── (narrow phones: two equal segments, count underneath) */}
        <GITContainersSection2
          allCompanies={allCompanies}
          data={data}
          restrictedToCurrentCompany={restrictedToCurrentCompany}
          setAllCompanies={setAllCompanies}
          setCompanyFilter={setCompanyFilter}
        />

        {/* ── Summary Cards ── (narrow phones: two columns; landscape keeps the wrapping row) */}
        <GITContainersSection
          arrived={arrived}
          atPort={atPort}
          atSea={atSea}
          data={data}
          delayed={delayed}
          filteredContainers={filteredContainers}
          inTransit={inTransit}
          leftDar={leftDar}
          offloadOverdue={offloadOverdue}
          totalCost={totalCost}
          totalTransportDuty={totalTransportDuty}
        />

        {/* ── Search + Filters Toggle ── (narrow phones: search row, then paired controls) */}
        <div className="flex shrink-0 items-center gap-2 flex-wrap max-sm:grid max-sm:grid-cols-2">
          <SearchField
            value={search}
            onValueChange={setSearch}
            placeholder="Search container #, company, truck, transporter, agent…"
            wrapperClassName="flex-1 min-w-48 max-sm:col-span-2 max-sm:min-w-0"
            className="h-10 rounded-xl border-border/80 bg-card shadow-sm dark:border-white/10 sm:h-11"
            data-testid="input-otw-search"
          />
          <Button
            variant={showFilters ? "default" : "outline"}
            size="default"
            className={cn(
              "h-10 rounded-xl px-4 font-semibold shadow-sm sm:h-11",
              showFilters
                ? "bg-violet-600 text-white hover:bg-violet-700"
                : "border-violet-500/40 text-violet-700 hover:bg-violet-500/10 dark:text-violet-300"
            )}
            aria-expanded={showFilters}
            aria-controls="otw-filter-panel"
            onClick={() => setShowFilters((v) => !v)}
            data-testid="button-otw-filters"
          >
            <Filter className="h-4 w-4 mr-1" />
            Filters
            {gitFilterCount > 0 && (
              <span
                className="ml-1 rounded-full bg-primary px-1.5 py-0.5 text-xs leading-none text-primary-foreground"
                data-testid="otw-filters-active-count"
              >
                {gitFilterCount}
              </span>
            )}
            {!isPhoneLayout && (
              <ChevronDown className={cn("h-3.5 w-3.5 ml-1 transition-transform", showFilters && "rotate-180")} />
            )}
          </Button>

          <GITContainersPopoverSection colVis={colVis} otwHiddenCount={otwHiddenCount} toggleOtwCol={toggleOtwCol} />

          <ContainerBulkActions
            allowPrivilegedActions={!restrictedToCurrentCompany}
            className="max-sm:col-span-2 max-sm:*:flex-1"
            waSending={waSending}
            onImportClick={() => fileInputRef.current?.click()}
            onSendWhatsApp={sendToWhatsApp}
            onPrint={() => window.print()}
          />
        </div>

        {activeFilterChips.length > 0 && (
          <div className="flex shrink-0 min-w-0 flex-wrap items-center gap-1.5" data-testid="otw-active-filter-chips">
            <span className="mr-1 text-xs text-muted-foreground">Active filters:</span>
            {activeFilterChips.slice(0, 5).map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={chip.clear}
                aria-label={`Remove ${chip.label} filter`}
                data-testid={`otw-filter-chip-${chip.key}`}
                className="inline-flex max-w-[210px] items-center gap-1.5 rounded-full border border-violet-300/70 bg-violet-100/80 px-2.5 py-1 text-xs font-medium text-violet-800 transition-colors hover:bg-violet-200 dark:border-violet-500/40 dark:bg-violet-500/15 dark:text-violet-200 dark:hover:bg-violet-500/25"
              >
                <span className="truncate">{chip.label}</span>
                <X className="h-3 w-3 shrink-0" aria-hidden="true" />
              </button>
            ))}
            {activeFilterChips.length > 5 && (
              <button
                type="button"
                onClick={() => setShowFilters(true)}
                className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"
              >
                +{activeFilterChips.length - 5} more
              </button>
            )}
            <button
              type="button"
              onClick={clearFilters}
              className="ml-1 px-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              data-testid="otw-clear-all-chips"
            >
              Clear all
            </button>
          </div>
        )}

        <input type="file" ref={fileInputRef} className="hidden" accept=".xlsx,.xls" onChange={handleFileChange} />

        {!isPhoneLayout && (
          <FilterBar
            showFilters={showFilters}
            onApply={() => setShowFilters(false)}
            companyFilter={companyFilter}
            setCompanyFilter={setCompanyFilter}
            companies={companies}
            containerNumbers={containerNumbers}
            containerFilters={containerFilters}
            setContainerFilters={setContainerFilters}
            suppliers={suppliers}
            supplierFilters={supplierFilters}
            setSupplierFilters={setSupplierFilters}
            transporters={transporters}
            transporterFilters={transporterFilters}
            setTransporterFilters={setTransporterFilters}
            agents={agents}
            agentFilters={agentFilters}
            setAgentFilters={setAgentFilters}
            trucks={trucks}
            truckFilters={truckFilters}
            setTruckFilters={setTruckFilters}
            locations={locations}
            locationFilters={locationFilters}
            setLocationFilters={setLocationFilters}
            docsFilter={docsFilter}
            setDocsFilter={setDocsFilter}
            delayedFilter={delayedFilter}
            setDelayedFilter={setDelayedFilter}
            freightFilter={freightFilter}
            setFreightFilter={setFreightFilter}
            etaFilter={etaFilter}
            setEtaFilter={setEtaFilter}
            allEtaDates={allEtaDates}
            hasContainersWithNoEta={hasContainersWithNoEta}
            notesFilter={notesFilter}
            setNotesFilter={setNotesFilter}
            sortOrder={sortOrder}
            setSortOrder={setSortOrder}
            clearFilters={clearFilters}
          />
        )}
        {isPhoneLayout && (
          <ErpFilterSheet
            open={showFilters}
            onOpenChange={setShowFilters}
            label="Container filters"
            onClear={clearFilters}
            canClear={gitFilterCount > 0}
            data-testid="otw-filters"
          >
            <FilterBar
              showFilters
              variant="sheet"
              companyFilter={companyFilter}
              setCompanyFilter={setCompanyFilter}
              companies={companies}
              containerNumbers={containerNumbers}
              containerFilters={containerFilters}
              setContainerFilters={setContainerFilters}
              suppliers={suppliers}
              supplierFilters={supplierFilters}
              setSupplierFilters={setSupplierFilters}
              transporters={transporters}
              transporterFilters={transporterFilters}
              setTransporterFilters={setTransporterFilters}
              agents={agents}
              agentFilters={agentFilters}
              setAgentFilters={setAgentFilters}
              trucks={trucks}
              truckFilters={truckFilters}
              setTruckFilters={setTruckFilters}
              locations={locations}
              locationFilters={locationFilters}
              setLocationFilters={setLocationFilters}
              docsFilter={docsFilter}
              setDocsFilter={setDocsFilter}
              delayedFilter={delayedFilter}
              setDelayedFilter={setDelayedFilter}
              freightFilter={freightFilter}
              setFreightFilter={setFreightFilter}
              etaFilter={etaFilter}
              setEtaFilter={setEtaFilter}
              allEtaDates={allEtaDates}
              hasContainersWithNoEta={hasContainersWithNoEta}
              notesFilter={notesFilter}
              setNotesFilter={setNotesFilter}
              sortOrder={sortOrder}
              setSortOrder={setSortOrder}
              clearFilters={clearFilters}
            />
          </ErpFilterSheet>
        )}

        <ImportResultBanner
          importResult={importResult}
          setImportResult={setImportResult}
          undoImportMutation={undoImportMutation}
        />

        <div className="flex-1 min-h-0">
          <ContainerTable
            containers={filteredContainers}
            colVis={colVis}
            sessionCompanyId={sessionCompanyId}
            readOnly={isViewOnly}
            propertiesMode={isProperties}
            onOpenDrawer={openDrawer}
            printRef={printRef}
          />
        </div>
      </div>

      <ContainerDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        container={drawerContainer}
        sessionCompanyId={sessionCompanyId}
        readOnly={isViewOnly}
      />
    </div>
  );
}
