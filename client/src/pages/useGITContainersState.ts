// Extracted from ./GITContainers.tsx to keep that module under the source-size cap.
import { getErrorDetails } from "@shared/errorUtils";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useCompany } from "@/contexts/CompanyContext";
import { authenticatedUserQueryOptions } from "@/contracts/sessionQueryContracts";
import {
  DEFAULT_OTW_COL_VIS,
  EnrichedContainerRow,
  type EtaFilterValue,
  fmt,
  OTW_COLS,
  OtwColId,
} from "./git-containers/gitContainerTypes";
import { useErpPhoneLayout } from "@/hooks/use-erp-phone-layout";
import { useContainerSummaryStats } from "./git-containers/containerHelpers";
import { useGITContainersData } from "./git-containers/useGITContainersData";
import { usePaginatedGITContainers } from "./git-containers/usePaginatedGITContainers";
import { isExistingRecordReadOnlyRole } from "@shared/createOnlyRolePolicy";

export function useGITContainersState({ embedded = false }: { embedded?: boolean } = {}) {
  const { data: user, isLoading: userLoading } = useQuery(authenticatedUserQueryOptions());
  const { selectedCompany } = useCompany();
  const isProperties = selectedCompany?.companyType === "properties";
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
  const isPhoneLayout = useErpPhoneLayout();
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

  const fileInputRef = useRef<HTMLInputElement>(null);
  const printRef = useRef<HTMLDivElement>(null);

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

  const allowedRoles = ["Admin", "Developer", "Owner", "ERP Tester", "View Only", "Create Only"];
  const effectiveRole = user?.currentRole ?? user?.role ?? "";
  const isAllowed = allowedRoles.includes(effectiveRole);
  const isTester = effectiveRole === "ERP Tester";
  const isViewOnly = isExistingRecordReadOnlyRole(effectiveRole);
  const restrictedToCurrentCompany = isTester || isViewOnly || isProperties;

  const { data, isLoading, isError, error, refetch, loadContainerDetail } = usePaginatedGITContainers({
    companyIdentity:
      !isProperties && allCompanies ? `all:${user?.id ?? "unknown"}` : (selectedCompany?.id ?? "no-company"),
    allCompanies: isProperties ? false : allCompanies,
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

  const { importMutation, undoImportMutation } = useGITContainersData({
    isSupplierPartner: selectedCompany?.companyType === "supplier_partner",
    refetch,
    toast,
    setImportResult,
  });

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
      const detail = await loadContainerDetail(
        c.id,
        data?.mode === "single" && data.companyId ? data.companyId : c.companyId,
        data?.mode === "all"
      );
      setDrawerContainer((current) => (current?.id === c.id ? detail : current));
    } catch (detailError) {
      toast({
        title: "Failed to load container details",
        description: getErrorDetails(detailError).message,
        variant: "destructive",
      });
    }
  }
  return {
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
  };
}
