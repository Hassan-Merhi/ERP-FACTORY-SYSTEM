// Extracted from ./StockEntryTab.tsx to keep that module under the source-size cap.
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { type ApplicationTranslationKey, translateApplicationText } from "@/i18n/applicationTranslations";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useCompany } from "@/contexts/CompanyContext";
import { useFormDraft } from "@/hooks/useFormDraft";
import { useLabelDesignColors } from "@/hooks/useLabelDesignColors";
import type { FactoryBaleProduct, FactoryCategory, Location } from "@shared/schema";
import type { WorkerCategoryRow, WorkerOption } from "./types";
import { eligibleProductionPositions, type StockEntryProductionPosition } from "./StockEntryProductionPositions";

export interface CartItem {
  productId: number;
  product: FactoryBaleProduct;
  qty: number;
  weightPerBaleKg: number;
  finalizedBy: number | null;
  overrideLogoId: number | null;
}

export const MAX_ITEMS_PER_ENTRY = 2;

export function capCartToItemLimit(items: CartItem[]): CartItem[] {
  return items.filter((item) => item.qty > 0).slice(0, MAX_ITEMS_PER_ENTRY);
}

export interface StockEntryTabProps {
  showHistory?: boolean;
  onOpenHistory?: () => void;
}

export function useStockEntryTabStatePart1() {
  const [cart, setCart] = useState<CartItem[]>([]);
  const [scanInput, setScanInput] = useState("");
  const [scanError, setScanError] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedLocationId, setSelectedLocationId] = useState<string>("");
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [entryDate, setEntryDate] = useState<string>(new Date().toLocaleDateString("en-CA"));
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>("none");
  const [selectedLogoId, setSelectedLogoId] = useState<number | null>(null);
  const [productionPositionByProduct, setProductionPositionByProduct] = useState<Record<number, number | null>>({});
  const scanRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const { language } = useApplicationLanguage();
  const tr = (key: ApplicationTranslationKey) => translateApplicationText(key, language);
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const { selectedCompany } = useCompany();
  const { colors: designColors } = useLabelDesignColors();

  const {
    hasDraft: hasCartDraft,
    draftAge: cartDraftAge,
    draft: cartDraft,
    scheduleSave: scheduleCartSave,
    discardDraft: discardCartDraft,
  } = useFormDraft({
    entityType: "factory-stock-entry-cart",
    mode: "factory",
    companyId: selectedCompany?.id ?? null,
  });

  useEffect(() => {
    if (cart.length > 0 || selectedLocationId) {
      scheduleCartSave({
        cart: cart.map((i) => ({
          productId: i.productId,
          productName: i.product.name,
          qty: i.qty,
          weightPerBaleKg: i.weightPerBaleKg,
          finalizedBy: i.finalizedBy,
          overrideLogoId: i.overrideLogoId,
        })),
        productionPositionByProduct,
        selectedLocationId,
        entryDate,
        selectedCustomerId,
        selectedLogoId,
      });
    }
  }, [
    cart,
    productionPositionByProduct,
    selectedLocationId,
    entryDate,
    selectedCustomerId,
    selectedLogoId,
    scheduleCartSave,
  ]);

  const { data: baleProducts } = useQuery<FactoryBaleProduct[]>({
    queryKey: ["/api/factory/bale-products?profile=picker"],
  });
  useQuery({ queryKey: ["/api/auth/me"] });
  const { data: locations } = useQuery<Location[]>({ queryKey: ["/api/locations"] });
  const { data: categories } = useQuery<FactoryCategory[]>({ queryKey: ["/api/factory/categories"] });

  const { data: workers = [] } = useQuery<WorkerOption[]>({
    queryKey: ["/api/factory/workers?profile=picker"],
    enabled: cart.length > 0,
  });
  const { data: workerCategoryGroups = [] } = useQuery<WorkerCategoryRow[]>({
    queryKey: ["/api/factory/worker-categories"],
    queryFn: () => fetch("/api/factory/worker-categories", { credentials: "include" }).then((r) => r.json()),
    enabled: cart.length > 0,
  });
  const { data: productionPositions = [], isLoading: productionPositionsLoading } = useQuery<
    StockEntryProductionPosition[]
  >({
    queryKey: ["/api/factory/production-positions", entryDate],
    queryFn: async () => {
      const response = await fetch(`/api/factory/production-positions?asOf=${encodeURIComponent(entryDate)}`, {
        credentials: "include",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message || "Failed to load production positions");
      return payload as StockEntryProductionPosition[];
    },
    enabled: cart.length > 0,
    staleTime: 30000,
  });
  const { data: allCustomers = [] } = useQuery({
    queryKey: ["/api/factory/customers"],
    queryFn: () => fetch("/api/factory/customers", { credentials: "include" }).then((r) => r.json()),
  });

  const [workerCategoryFilter, setWorkerCategoryFilter] = useState("all");
  const [workerCategoryFilterManual, setWorkerCategoryFilterManual] = useState(false);

  useEffect(() => {
    if (workerCategoryGroups.length > 0 && !workerCategoryFilterManual) {
      const pressing = workerCategoryGroups.find((c) => c.name?.toLowerCase().includes("pressing"));
      if (pressing) {
        setWorkerCategoryFilter(String(pressing.id));
      }
    }
  }, [workerCategoryGroups, workerCategoryFilterManual]);

  const filteredWorkers =
    workerCategoryFilter === "all"
      ? workers.filter((w) => w.active !== false)
      : (() => {
          const cat = workerCategoryGroups.find((c) => String(c.id) === workerCategoryFilter);
          if (!cat) return workers.filter((w) => w.active !== false);
          const ids = Array.isArray(cat.workerIds) ? cat.workerIds : [];
          return workers.filter((w) => w.active !== false && ids.includes(w.id));
        })();

  // Keep attribution valid when the entry date, membership configuration, cart,
  // or selected worker changes. While a new date is loading we preserve the
  // current choice; once its memberships arrive, invalid choices are cleared and
  // a single eligible position is selected automatically.
  useEffect(() => {
    if (productionPositionsLoading) return;
    setProductionPositionByProduct((current) => {
      const next = { ...current };
      let changed = false;
      const productIds = new Set(cart.map((item) => item.productId));

      for (const key of Object.keys(next)) {
        const productId = Number(key);
        if (!productIds.has(productId)) {
          delete next[productId];
          changed = true;
        }
      }

      for (const item of cart) {
        const eligible = eligibleProductionPositions(productionPositions, item.finalizedBy);
        const existing = next[item.productId] ?? null;
        const existingIsValid = existing != null && eligible.some((position) => position.id === existing);
        const desired = !item.finalizedBy
          ? null
          : existingIsValid
            ? existing
            : eligible.length === 1
              ? eligible[0].id
              : null;
        if (existing !== desired) {
          next[item.productId] = desired;
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [cart, productionPositions, productionPositionsLoading]);

  const [quickCreateOpen, setQuickCreateOpen] = useState(false);
  const [quickCreateName, setQuickCreateName] = useState("");
  const [quickCreateCategoryId, setQuickCreateCategoryId] = useState("");
  const [quickCreateWeight, setQuickCreateWeight] = useState("");
  const [quickCreateGrade, setQuickCreateGrade] = useState("");
  const [adminAuthOpen, setAdminAuthOpen] = useState(false);
  const [pendingAdminAuth, setPendingAdminAuth] = useState<{ username: string; password: string } | null>(null);
  const [pendingCreateName, setPendingCreateName] = useState("");

  const activeCategories = (categories || []).filter((c) => c.isActive);
  return {
    activeCategories,
    adminAuthOpen,
    allCustomers,
    baleProducts,
    cart,
    cartDraft,
    cartDraftAge,
    confirmDialogOpen,
    designColors,
    discardCartDraft,
    entryDate,
    filteredWorkers,
    hasCartDraft,
    locations,
    modeApiRequest,
    pendingAdminAuth,
    pendingCreateName,
    productionPositionByProduct,
    productionPositions,
    productionPositionsLoading,
    quickCreateCategoryId,
    quickCreateGrade,
    quickCreateName,
    quickCreateOpen,
    quickCreateWeight,
    scanError,
    scanInput,
    scanRef,
    selectedCustomerId,
    selectedLocationId,
    selectedLogoId,
    setAdminAuthOpen,
    setCart,
    setConfirmDialogOpen,
    setEntryDate,
    setPendingAdminAuth,
    setPendingCreateName,
    setProductionPositionByProduct,
    setQuickCreateCategoryId,
    setQuickCreateGrade,
    setQuickCreateName,
    setQuickCreateOpen,
    setQuickCreateWeight,
    setScanError,
    setScanInput,
    setSelectedCustomerId,
    setSelectedLocationId,
    setSelectedLogoId,
    setShowDropdown,
    setWorkerCategoryFilter,
    setWorkerCategoryFilterManual,
    showDropdown,
    toast,
    tr,
    workerCategoryFilter,
    workerCategoryGroups,
    workers,
  };
}
