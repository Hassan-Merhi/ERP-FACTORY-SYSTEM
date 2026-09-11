import { getErrorDetails } from "@shared/errorUtils";
import { useState, useEffect, useRef, ChangeEvent } from "react";
import { Redirect } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Ship,
  Truck,
  Package,
  AlertTriangle,
  Clock,
  DollarSign,
  Search,
  Filter,
  CheckCircle2,
  ChevronDown,
  Building2,
  Globe,
  SlidersHorizontal,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { cn } from "@/lib/utils";
import { isBlockingQueryError } from "@/lib/abortError";
import { useToast } from "@/hooks/use-toast";
import { useCompany } from "@/contexts/CompanyContext";
import { authenticatedUserQueryOptions } from "@/contracts/sessionQueryContracts";

// Sub-component imports
import {
  EnrichedContainerRow,
  OTW_COLS,
  OtwColId,
  DEFAULT_OTW_COL_VIS,
  BulkProgress,
  fmt,
  type EtaFilterValue,
} from "./git-containers/gitContainerTypes";
import { SummaryCard } from "./git-containers/InlineCells";
import { ContainerDrawer } from "./git-containers/ContainerDrawer";
import { ContainerTable } from "./git-containers/ContainerTable";
import { ContainerBulkActions } from "./git-containers/ContainerBulkActions";
import { BulkProgressBanner } from "./git-containers/BulkProgressBanner";
import { FilterBar } from "./git-containers/FilterBar";
import { ImportResultBanner } from "./git-containers/ImportResultBanner";
import { useContainerSummaryStats } from "./git-containers/containerHelpers";
import { useGITContainersData } from "./git-containers/useGITContainersData";
import { usePaginatedGITContainers } from "./git-containers/usePaginatedGITContainers";

export default function GITContainers({ embedded = false }: { embedded?: boolean } = {}) {
  const { data: user, isLoading: userLoading } = useQuery(authenticatedUserQueryOptions());
  const { selectedCompany } = useCompany();
  const { toast } = useToast();

  const [allCompanies, setAllCompanies] = useState(false);
  const [companyFilter, setCompanyFilter] = useState("ALL");
  const [containerFilters, setContainerFilters] = useState<string[]>([]);
  const [supplierFilters, setSupplierFilters] = useState<string[]>([]);
  const [transporterFilters, setTransporterFilters] = useState<string[]>([]);
  const [agentFilters, setAgentFilters] = useState<string[]>([]);
  const [truckFilters, setTruckFilters] = useState<string[]>([]);
  const [locationFilters, setLocationFilters] = useState<string[]>([]);
  const [docsFilter, setDocsFilter] = useState("ALL");
  const [delayedFilter, setDelayedFilter] = useState("ALL");
  const [freightFilter, setFreightFilter] = useState("ALL");
  const [etaFilter, setEtaFilter] = useState<EtaFilterValue>("ALL");
  const [notesFilter, setNotesFilter] = useState("ALL");
  const [sortOrder, setSortOrder] = useState("DEFAULT");
  const [search, setSearch] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerContainer, setDrawerContainer] = useState<EnrichedContainerRow | null>(null);
  const [importResult, setImportResult] = useState<{
    updated: number;
    skipped: number;
    notFound: number;
    errors: string[];
    importId: string | null;
  } | null>(null);
  const [waSending, setWaSending] = useState(false);
  const CONTAINER_CHUNK_SIZE = 50;

  const [bulkProgress, setBulkProgress] = useState<BulkProgress | null>(null);
  const [showProgressBanner, setShowProgressBanner] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const printRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  // ── Column visibility (per-user, persisted to localStorage) ──────────────────
  const [colVis, setColVis] = useState<Record<OtwColId, boolean>>(DEFAULT_OTW_COL_VIS);
  useEffect(() => {
    if (!user?.id) return;
    try {
      const saved = localStorage.getItem(`otw_col_vis_${user.id}`);
      if (saved) setColVis({ ...DEFAULT_OTW_COL_VIS, ...JSON.parse(saved) });
    } catch {
      // Storage is unavailable in private mode and can throw on quota; the value is a convenience, not state we need.
    }
  }, [user?.id]);
  function toggleOtwCol(id: OtwColId) {
    setColVis((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        if (user?.id) localStorage.setItem(`otw_col_vis_${user.id}`, JSON.stringify(next));
      } catch {
        // Storage is unavailable in private mode and can throw on quota; the value is a convenience, not state we need.
      }
      return next;
    });
  }
  const otwHiddenCount = OTW_COLS.filter((c) => !colVis[c.id]).length;

  const allowedRoles = ["Admin", "Developer", "Owner"];
  const effectiveRole = user?.currentRole ?? user?.role ?? "";
  const isAllowed = allowedRoles.includes(effectiveRole);

  const { data, isLoading, isError, error, refetch, loadContainerDetail } = usePaginatedGITContainers({
    companyIdentity: allCompanies ? `all:${user?.id ?? "unknown"}` : (selectedCompany?.id ?? "no-company"),
    allCompanies,
    pageSize: CONTAINER_CHUNK_SIZE,
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
    search,
    enabled: !!isAllowed && !!selectedCompany,
  });

  const allContainers = data?.containers ?? [];

  const { importMutation, undoImportMutation, bulkEnableMutation, bulkTrackMutation } = useGITContainersData({
    isAllowed,
    refetch,
    toast,
    setImportResult,
    setShowProgressBanner,
    setBulkProgress,
    queryClient,
    showProgressBanner,
  });

  const isBulkPending = bulkTrackMutation.isPending;

  const filteredContainers = allContainers;

  const localSummary = useContainerSummaryStats({ filteredContainers });
  const atSea = data?.summary?.atSea ?? localSummary.atSea;
  const atPort = data?.summary?.atPort ?? localSummary.atPort;
  const leftDar = data?.summary?.leftDar ?? localSummary.leftDar;
  const inTransit = data?.summary?.inTransit ?? localSummary.inTransit;
  const arrived = data?.summary?.arrived ?? localSummary.arrived;
  const delayed = data?.summary?.delayed ?? localSummary.delayed;
  const offloadOverdue = data?.summary?.overdue ?? localSummary.offloadOverdue;
  const totalCost = data?.summary ? `$${fmt(data.summary.totalCost)}` : localSummary.totalCost;
  const totalTransportDuty = data?.summary
    ? `$${fmt(data.summary.totalTransportDuty)}`
    : localSummary.totalTransportDuty;

  const companies = data?.facets?.companies ?? [...new Set(allContainers.map((c) => c.companyName))].sort();
  const containerNumbers =
    data?.facets?.containerNumbers ?? [...new Set(allContainers.map((c) => c.containerNumber))].sort();
  const suppliers =
    data?.facets?.suppliers ??
    ([...new Set(allContainers.map((c) => c.supplierCode).filter(Boolean))].sort() as string[]);
  const transporters =
    data?.facets?.transporters ??
    ([...new Set(allContainers.map((c) => c.transporter).filter(Boolean))].sort() as string[]);
  const agents =
    data?.facets?.agents ?? ([...new Set(allContainers.map((c) => c.agent).filter(Boolean))].sort() as string[]);
  const trucks =
    data?.facets?.trucks ?? ([...new Set(allContainers.map((c) => c.numberPlate).filter(Boolean))].sort() as string[]);
  const locations =
    data?.facets?.locations ??
    ([...new Set(allContainers.map((c) => c.trackingLocation).filter(Boolean))].sort() as string[]);
  const allEtaDates =
    data?.facets?.etaDates ?? ([...new Set(allContainers.map((c) => c.eta).filter(Boolean))].sort() as string[]);
  const hasContainersWithNoEta = data?.facets?.hasContainersWithNoEta ?? allContainers.some((c) => !c.eta);

  async function openDrawer(c: EnrichedContainerRow) {
    setDrawerContainer(c);
    setDrawerOpen(true);
    try {
      const detail = await loadContainerDetail(c.id, c.companyId);
      setDrawerContainer((current) => (current?.id === c.id ? detail : current));
    } catch (detailError) {
      toast({
        title: "Failed to load container details",
        description: getErrorDetails(detailError).message,
        variant: "destructive",
      });
    }
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    importMutation.mutate(file);
    e.target.value = "";
  }

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
      {!embedded && <PageHeader title="Containers OTW" subtitle="Active container logistics and tracking" />}

      <div className="flex-1 overflow-hidden p-4 flex flex-col gap-4">
        {/* ── Company Mode ── */}
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => {
              setAllCompanies(false);
              setCompanyFilter("ALL");
            }}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors",
              !allCompanies
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background border-border text-muted-foreground hover-elevate"
            )}
            data-testid="button-my-company"
          >
            <Building2 className="h-3.5 w-3.5" />
            My Company
          </button>
          <button
            onClick={() => {
              setAllCompanies(true);
              setCompanyFilter("ALL");
            }}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors",
              allCompanies
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background border-border text-muted-foreground hover-elevate"
            )}
            data-testid="button-all-companies"
          >
            <Globe className="h-3.5 w-3.5" />
            All Accessible Companies
          </button>
          {data && (
            <span className="text-xs text-muted-foreground ml-1">
              {data.total} active container{data.total !== 1 ? "s" : ""}
              {data.mode === "single" && data.companyName ? ` — ${data.companyName}` : ""}
            </span>
          )}
        </div>

        {/* ── Summary Cards ── */}
        <div className="flex flex-wrap gap-2">
          <SummaryCard
            label="Active"
            value={data?.summary?.total ?? data?.total ?? filteredContainers.length}
            icon={<Package className="h-4 w-4 text-primary" />}
            accent="bg-primary/10"
          />
          {atSea > 0 && (
            <SummaryCard
              label="At Sea / OTW"
              value={atSea}
              icon={<Ship className="h-4 w-4 text-blue-600" />}
              accent="bg-blue-100 dark:bg-blue-900/30"
            />
          )}
          {atPort > 0 && (
            <SummaryCard
              label="At Port"
              value={atPort}
              icon={<Package className="h-4 w-4 text-amber-600" />}
              accent="bg-amber-100 dark:bg-amber-900/30"
            />
          )}
          {leftDar > 0 && (
            <SummaryCard
              label="Left Dar"
              value={leftDar}
              icon={<Truck className="h-4 w-4 text-violet-600" />}
              accent="bg-violet-100 dark:bg-violet-900/30"
            />
          )}
          {inTransit > 0 && (
            <SummaryCard
              label="In Transit"
              value={inTransit}
              icon={<Truck className="h-4 w-4 text-indigo-600" />}
              accent="bg-indigo-100 dark:bg-indigo-900/30"
            />
          )}
          {arrived > 0 && (
            <SummaryCard
              label="Arrived"
              value={arrived}
              icon={<CheckCircle2 className="h-4 w-4 text-green-600" />}
              accent="bg-green-100 dark:bg-green-900/30"
            />
          )}
          {delayed > 0 && (
            <SummaryCard
              label="Delayed"
              value={delayed}
              icon={<Clock className="h-4 w-4 text-red-600" />}
              accent="bg-red-100 dark:bg-red-900/30"
            />
          )}
          {offloadOverdue > 0 && (
            <SummaryCard
              label="Offload Overdue"
              value={offloadOverdue}
              icon={<AlertTriangle className="h-4 w-4 text-red-600" />}
              accent="bg-red-100 dark:bg-red-900/30"
            />
          )}
          <SummaryCard
            label="Container Cost"
            value={totalCost}
            icon={<DollarSign className="h-4 w-4 text-green-600" />}
            accent="bg-green-100 dark:bg-green-900/30"
          />
          <SummaryCard
            label="Transport + Duty"
            value={totalTransportDuty}
            icon={<DollarSign className="h-4 w-4 text-muted-foreground" />}
          />
        </div>

        {/* ── Search + Filters Toggle ── */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-48">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search container #, company, truck, transporter, agent…"
              className="pl-8"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid="input-otw-search"
            />
          </div>
          <Button
            variant="outline"
            size="default"
            onClick={() => setShowFilters((v) => !v)}
            data-testid="button-otw-filters"
          >
            <Filter className="h-4 w-4 mr-1" />
            Filters
            <ChevronDown className={cn("h-3.5 w-3.5 ml-1 transition-transform", showFilters && "rotate-180")} />
          </Button>

          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="default" data-testid="button-otw-columns">
                <SlidersHorizontal className="h-4 w-4 mr-1" />
                Columns
                {otwHiddenCount > 0 && (
                  <span className="ml-1 text-xs bg-primary text-primary-foreground rounded-full px-1.5 py-0.5 leading-none">
                    {otwHiddenCount}
                  </span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-52 p-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 px-1">
                Show / Hide Columns
              </p>
              <div className="space-y-0.5">
                {OTW_COLS.map((col) => (
                  <label
                    key={col.id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-md hover-elevate cursor-pointer text-sm"
                    data-testid={`col-toggle-otw-${col.id}`}
                  >
                    <Checkbox checked={colVis[col.id]} onCheckedChange={() => toggleOtwCol(col.id)} />
                    {col.label}
                  </label>
                ))}
              </div>
            </PopoverContent>
          </Popover>

          <ContainerBulkActions
            isAllowed={isAllowed}
            isBulkPending={isBulkPending}
            allContainersCount={data?.total ?? allContainers.length}
            waSending={waSending}
            onTrackAll={() => bulkTrackMutation.mutate()}
            onImportClick={() => fileInputRef.current?.click()}
            onBulkEnable={(enabled) => bulkEnableMutation.mutate(enabled)}
            onSendWhatsApp={sendToWhatsApp}
            onPrint={() => window.print()}
          />
        </div>

        <input type="file" ref={fileInputRef} className="hidden" accept=".xlsx,.xls" onChange={handleFileChange} />

        <BulkProgressBanner
          showProgressBanner={showProgressBanner}
          bulkProgress={bulkProgress}
          setShowProgressBanner={setShowProgressBanner}
        />

        <FilterBar
          showFilters={showFilters}
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
      />
    </div>
  );
}
