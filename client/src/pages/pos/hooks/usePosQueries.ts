import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { locationInventoryLightUrl } from "@/api/inventoryApi";
import type { AuthMe } from "@shared/apiTypes";
import type {
  APIInventoryItem,
  BankAccountRow,
  CompanySettingsRow,
  LedgerPickerAccount,
  Location,
  PosDraftSummary,
  PosEditVoucher,
  PosShift,
  PosViewEntry,
} from "../pos-components/posTypes";
import { buildPosInventory, type SpMovement } from "./posInventory";

interface PosQueriesParams {
  posUser?: AuthMe | null;
  activeLocation: Location | null;
  companyId?: number;
  isCreditSale: boolean;
  editVoucherId?: string;
  showPrintDialog: boolean;
  showStockPrompt: boolean;
  /** Supplier Partner companies source their sellable stock from sp_stock_movements, not the normal inventory table. */
  isSpCompany?: boolean;
}

type StockInventoryItem = APIInventoryItem & { stock: string };

export interface GoldenCoastPosReadiness {
  isGoldenCoast: boolean;
  canPost?: boolean;
  blockers?: string[];
  costLotCount?: number;
  parentCompanyId?: number | null;
}

export function usePosQueries({
  posUser,
  activeLocation,
  companyId,
  isCreditSale,
  editVoucherId,
  showPrintDialog,
  showStockPrompt,
  isSpCompany,
}: PosQueriesParams) {
  const { data: goldenCoastReadiness, isLoading: goldenCoastReadinessLoading } = useQuery<GoldenCoastPosReadiness>({
    queryKey: companyId ? ["/api/sp/golden-coast/phase6/pos-sale/readiness", companyId] : [],
    enabled: !!isSpCompany && !!companyId,
    retry: false,
    queryFn: async () => {
      const res = await fetch("/api/sp/golden-coast/phase6/pos-sale/readiness", {
        credentials: "include",
      });
      const body = await res.json().catch(() => null);

      // Non-Golden-Coast Supplier Partners are expected to receive the
      // configured 409 response from this probe. Treat that as a normal
      // negative result so their legacy POS flow remains unchanged.
      if (res.status === 409 && body?.code === "GC_PHASE6_NOT_CONFIGURED") {
        return { isGoldenCoast: false };
      }
      if (!res.ok) {
        throw new Error(body?.message || "Failed to check Golden Coast POS readiness");
      }
      return { ...body, isGoldenCoast: true };
    },
  });

  const { data: posAssignedLocations = [], isLoading: posLocationsLoading } = useQuery<Location[]>({
    queryKey: posUser ? ["/api/my-locations"] : [],
    enabled: !!posUser,
  });

  const { data: allLocations = [] } = useQuery<Location[]>({
    queryKey: ["/api/locations"],
    enabled: !posUser,
  });

  const { data: companySettings } = useQuery<CompanySettingsRow>({
    queryKey: ["/api/company-settings"],
    enabled: !!posUser,
  });

  const posInventoryUrl = activeLocation ? locationInventoryLightUrl(activeLocation.id, true) : null;
  const {
    data: apiInventory = [],
    isLoading: inventoryLoading,
    error: inventoryError,
    refetch: refetchInventory,
  } = useQuery<APIInventoryItem[]>({
    queryKey: posInventoryUrl ? [posInventoryUrl] : [],
    // POS only needs item identity, quantity and selling-price data. The compact
    // route avoids downloading stock-group/category/metadata fields on every
    // location inventory read while preserving the POS cost-visibility boundary.
    enabled: !!posInventoryUrl,
  });

  // Supplier Partner companies still need the SP lots for final-cost/FIFO data.
  // Scope the cache by location so switching locations (or companies, whose
  // location IDs are globally unique) cannot reuse a stale empty stock response.
  const {
    data: spStock = [],
    isLoading: spStockLoading,
    error: spStockError,
    refetch: refetchSpStock,
  } = useQuery<SpMovement[]>({
    queryKey: activeLocation ? ["/api/sp/stock", activeLocation.id] : [],
    queryFn: async () => {
      const res = await fetch("/api/sp/stock", { credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || "Failed to load Supplier Partner stock");
      }
      return res.json();
    },
    enabled: !!isSpCompany && !!activeLocation,
  });

  const inventory = useMemo(
    () => buildPosInventory(apiInventory, spStock, !!isSpCompany, activeLocation ? Number(activeLocation.id) : null),
    [apiInventory, spStock, isSpCompany, activeLocation]
  );

  const { data: bankAccounts = [] } = useQuery<BankAccountRow[]>({
    queryKey: ["/api/bank-accounts"],
    enabled: !!activeLocation,
  });

  const { data: allLedgerAccounts = [] } = useQuery<LedgerPickerAccount[]>({
    queryKey: ["/api/ledger-accounts?profile=picker"],
    enabled: !!activeLocation,
  });

  const cashLedgerAccounts = useMemo(
    () => (Array.isArray(allLedgerAccounts) ? allLedgerAccounts : []).filter((acc) => acc.accountType === "Cash"),
    [allLedgerAccounts]
  );
  const customerAccounts = useMemo(
    () => (Array.isArray(allLedgerAccounts) ? allLedgerAccounts : []).filter((acc) => acc.accountType === "Asset"),
    [allLedgerAccounts]
  );

  const { data: drafts = [], refetch: refetchDrafts } = useQuery<PosDraftSummary[]>({
    queryKey: activeLocation ? [`/api/pos/drafts?locationId=${activeLocation.id}`] : [],
    enabled: !!activeLocation,
  });

  const { data: currentShift } = useQuery<PosShift | null>({
    queryKey: posUser && activeLocation ? ["/api/pos/shifts/current", { locationId: activeLocation.id }] : [],
    queryFn: async () => {
      if (!activeLocation) return null;
      const res = await fetch(`/api/pos/shifts/current?locationId=${activeLocation.id}`, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!posUser && !!activeLocation,
    refetchInterval: 60_000,
  });

  const { data: authUser } = useQuery<AuthMe>({ queryKey: ["/api/auth/me"] });

  const { data: lastSoldPrices = {} } = useQuery<Record<number, string>>({
    queryKey: activeLocation ? ["/api/pos/last-sold-prices", { locationId: activeLocation.id }] : [],
    queryFn: async () => {
      if (!activeLocation) return {};
      const res = await fetch(`/api/pos/last-sold-prices?locationId=${activeLocation.id}`, { credentials: "include" });
      if (!res.ok) return {};
      return res.json();
    },
    enabled: !!activeLocation,
    staleTime: 60_000,
  });

  const { data: posCustomers = [] } = useQuery<LedgerPickerAccount[]>({
    queryKey: ["/api/pos/customers"],
    enabled: isCreditSale && authUser?.canAccessCustomers === true,
  });

  const { data: editVoucher, isLoading: editVoucherLoading } = useQuery<PosEditVoucher>({
    queryKey: editVoucherId ? [`/api/vouchers/${editVoucherId}`] : [],
    enabled: !!editVoucherId,
  });

  // Fallback: if the voucher loaded but has no salesItems (e.g. items were stored separately),
  // fetch from view-entries which always includes stock items for Sales type.
  const editVoucherHasSalesItems =
    editVoucher && Array.isArray(editVoucher.salesItems) && editVoucher.salesItems.length > 0;
  const { data: editVoucherViewEntries = [] } = useQuery<PosViewEntry[]>({
    queryKey:
      editVoucherId && editVoucher && !editVoucherHasSalesItems ? [`/api/vouchers/${editVoucherId}/view-entries`] : [],
    enabled: !!editVoucherId && !!editVoucher && !editVoucherHasSalesItems,
    staleTime: 60_000,
  });

  // Stock inventory — use the exact compact query key shared by other item/qty
  // consumers. `select` shapes the view without creating a second network cache.
  const printLocationId = activeLocation?.id ?? editVoucher?.locationId ?? null;
  const stockInventoryUrl = printLocationId ? locationInventoryLightUrl(printLocationId) : null;
  const { data: stockInventory = [], isLoading: stockInventoryLoading } = useQuery<
    APIInventoryItem[],
    Error,
    StockInventoryItem[]
  >({
    queryKey: stockInventoryUrl ? [stockInventoryUrl] : [],
    enabled: (showPrintDialog || showStockPrompt) && !!stockInventoryUrl,
    select: (rows) => rows.map((item) => ({ ...item, stock: item.quantity })),
  });

  return {
    posAssignedLocations,
    posLocationsLoading,
    allLocations,
    companySettings,
    apiInventory,
    inventoryLoading: isSpCompany ? inventoryLoading || spStockLoading : inventoryLoading,
    inventoryError: isSpCompany ? inventoryError || spStockError : inventoryError,
    refetchInventory: () => {
      void refetchInventory();
      if (isSpCompany) void refetchSpStock();
    },
    inventory,
    bankAccounts,
    allLedgerAccounts,
    cashLedgerAccounts,
    customerAccounts,
    drafts,
    refetchDrafts,
    currentShift,
    authUser,
    goldenCoastPhase6: goldenCoastReadiness?.isGoldenCoast === true,
    goldenCoastReadinessLoading,
    goldenCoastReadiness,
    lastSoldPrices,
    posCustomers,
    editVoucher,
    editVoucherLoading,
    editVoucherViewEntries,
    stockInventory,
    stockInventoryLoading,
  };
}
