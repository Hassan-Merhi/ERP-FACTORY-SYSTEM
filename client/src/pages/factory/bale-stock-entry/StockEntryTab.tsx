import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Plus, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useCompany } from "@/contexts/CompanyContext";
import { useFormDraft } from "@/hooks/useFormDraft";
import { DraftRestorePrompt } from "@/components/DraftRestorePrompt";
import { getPaperFormat } from "@/components/LabelPrintSettings";
import { useLabelDesignColors } from "@/hooks/useLabelDesignColors";
import {
  generateCombinedLabelsHtml,
  generateA5LabelsHtml,
  prefetchBannersForPrint,
  type LabelData,
} from "@/lib/labelHtml";
import type { FactoryBaleProduct, Location, FactoryCategory } from "@shared/schema";
import { productMatchesSearch } from "@shared/factoryProductSearch";

import { StockEntryCart } from "./StockEntryCart";
import type { WorkerCategoryRow, WorkerOption } from "./types";
import {
  ConfirmStockEntryDialog,
  QuickCreateProductDialog,
  DesignPickerDialog,
  AdminAuthDialog,
} from "./StockEntryDialogs";
import { StockEntryScanner } from "./StockEntryScanner";
import { StockEntrySidebar } from "./StockEntrySidebar";
import { openBrowserPrint, printLabels } from "./StockEntryPrinting";
import {
  StockEntryProductionPositions,
  eligibleProductionPositions,
  type StockEntryProductionPosition,
} from "./StockEntryProductionPositions";

interface CartItem {
  productId: number;
  product: FactoryBaleProduct;
  qty: number;
  weightPerBaleKg: number;
  finalizedBy: number | null;
  overrideLogoId: number | null;
}

export function StockEntryTab() {
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

  const { data: baleProducts, isLoading: _productsLoading } = useQuery<FactoryBaleProduct[]>({
    queryKey: ["/api/factory/bale-products"],
  });
  const { data: _currentUser } = useQuery({ queryKey: ["/api/auth/me"] });
  const { data: locations } = useQuery<Location[]>({ queryKey: ["/api/locations"] });
  const { data: categories } = useQuery<FactoryCategory[]>({ queryKey: ["/api/factory/categories"] });

  const { data: workers = [] } = useQuery<WorkerOption[]>({
    queryKey: ["/api/factory/workers"],
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

  const quickCreateMutation = useMutation({
    mutationFn: async () => {
      const body: {
        name: string;
        categoryId?: number;
        weightPerBaleKg?: string;
        grade?: string;
        adminAuth?: { username: string; password: string };
      } = {
        name: quickCreateName,
      };
      if (quickCreateCategoryId) body.categoryId = parseInt(quickCreateCategoryId);
      if (quickCreateWeight) body.weightPerBaleKg = quickCreateWeight;
      if (quickCreateGrade) body.grade = quickCreateGrade;
      if (pendingAdminAuth) body.adminAuth = pendingAdminAuth;
      const response = await modeApiRequest("POST", "/api/factory/bale-products", body);
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.message || "Failed to create product");
      }
      return await response.json();
    },
    onSuccess: (newProduct: FactoryBaleProduct) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-products"] });
      toast({
        title: "Product Created",
        description: `"${newProduct.name}" created with article code ${newProduct.articleCode}`,
      });
      setQuickCreateOpen(false);
      setQuickCreateName("");
      setQuickCreateCategoryId("");
      setQuickCreateWeight("");
      setQuickCreateGrade("");
      setPendingAdminAuth(null);
      setPendingCreateName("");
      setScanInput("");
      setShowDropdown(false);
      const defaultWeight = newProduct.weightPerBaleKg ? parseFloat(newProduct.weightPerBaleKg) : 25;
      setCart((prev) => [
        ...prev,
        {
          productId: newProduct.id,
          product: newProduct,
          qty: 1,
          weightPerBaleKg: defaultWeight,
          finalizedBy: null,
          overrideLogoId: null,
        },
      ]);
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const activeProducts = (baleProducts || []).filter((p) => p.active);
  const activeLocations = (locations || []).filter((l) => l.active);

  useEffect(() => {
    if (activeLocations && activeLocations.length === 1 && !selectedLocationId) {
      setSelectedLocationId(activeLocations[0].id.toString());
    }
  }, [activeLocations, selectedLocationId]);

  useEffect(() => {
    const active = document.activeElement;
    const isOtherInputFocused =
      active &&
      active !== scanRef.current &&
      (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT");
    if (scanRef.current && !isOtherInputFocused) scanRef.current.focus();
  }, [cart]);

  const handleScan = (value: string) => {
    if (!value.trim()) return;
    setScanError("");

    const trimmed = value.trim().toLowerCase();
    const product = activeProducts?.find(
      (p) => p.articleCode?.toLowerCase() === trimmed || p.code.toLowerCase() === trimmed
    );

    if (!product) {
      setScanError(`Unknown product: "${value}"`);
      setScanInput("");
      return;
    }

    const defaultWeight = product.weightPerBaleKg ? parseFloat(product.weightPerBaleKg) : 25;

    setCart((prev) => {
      const existing = prev.find((item) => item.productId === product.id);
      if (existing) {
        return prev.map((item) => (item.productId === product.id ? { ...item, qty: item.qty + 1 } : item));
      }
      return [
        ...prev,
        {
          productId: product.id,
          product,
          qty: 1,
          weightPerBaleKg: defaultWeight,
          finalizedBy: null,
          overrideLogoId: null,
        },
      ];
    });

    setScanInput("");
  };

  const handleScanKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleScan(scanInput);
    }
  };

  const filteredProducts =
    scanInput.trim().length > 0
      ? (activeProducts || []).filter((p) => productMatchesSearch(p, scanInput)).slice(0, 1000)
      : [];

  const selectProduct = (product: FactoryBaleProduct) => {
    const defaultWeight = product.weightPerBaleKg ? parseFloat(product.weightPerBaleKg) : 25;
    setCart((prev) => {
      const existing = prev.find((item) => item.productId === product.id);
      if (existing) {
        return prev.map((item) => (item.productId === product.id ? { ...item, qty: item.qty + 1 } : item));
      }
      return [
        ...prev,
        {
          productId: product.id,
          product,
          qty: 1,
          weightPerBaleKg: defaultWeight,
          finalizedBy: null,
          overrideLogoId: null,
        },
      ];
    });
    setScanInput("");
    setScanError("");
    setShowDropdown(false);
  };

  const updateQty = (productId: number, delta: number) => {
    setCart((prev) =>
      prev
        .map((item) => (item.productId === productId ? { ...item, qty: Math.max(0, item.qty + delta) } : item))
        .filter((item) => item.qty > 0)
    );
  };

  const setQty = (productId: number, qty: number) => {
    if (qty <= 0) {
      setCart((prev) => prev.filter((item) => item.productId !== productId));
      setProductionPositionByProduct((prev) => {
        if (!(productId in prev)) return prev;
        const next = { ...prev };
        delete next[productId];
        return next;
      });
    } else {
      setCart((prev) => prev.map((item) => (item.productId === productId ? { ...item, qty } : item)));
    }
  };

  const updateWeight = (productId: number, weight: number) => {
    setCart((prev) => prev.map((item) => (item.productId === productId ? { ...item, weightPerBaleKg: weight } : item)));
  };

  const removeItem = (productId: number) => {
    setCart((prev) => prev.filter((item) => item.productId !== productId));
    setProductionPositionByProduct((prev) => {
      if (!(productId in prev)) return prev;
      const next = { ...prev };
      delete next[productId];
      return next;
    });
  };

  const assignWorker = (productId: number, workerId: number | null) => {
    const eligible = eligibleProductionPositions(productionPositions, workerId);
    const autoPositionId = eligible.length === 1 ? eligible[0].id : null;
    setCart((prev) => prev.map((item) => (item.productId === productId ? { ...item, finalizedBy: workerId } : item)));
    setProductionPositionByProduct((prev) => ({ ...prev, [productId]: autoPositionId }));
  };

  const assignProductionPosition = (productId: number, positionId: number | null) => {
    setProductionPositionByProduct((prev) => ({ ...prev, [productId]: positionId }));
  };

  const setLogoOverride = (productId: number, logoId: number | null) => {
    setCart((prev) => prev.map((item) => (item.productId === productId ? { ...item, overrideLogoId: logoId } : item)));
  };

  const [logoPickerOpen, setLogoPickerOpen] = useState<number | null>(null);

  const totalQty = cart.reduce((sum, item) => sum + item.qty, 0);
  const totalKg = cart.reduce((sum, item) => sum + item.qty * item.weightPerBaleKg, 0);

  const handleConfirmClick = () => {
    if (!selectedLocationId) {
      toast({ title: "Error", description: "Please select a warehouse location", variant: "destructive" });
      return;
    }
    if (cart.length === 0) {
      toast({ title: "Error", description: "Please add items to the cart", variant: "destructive" });
      return;
    }
    if (cart.some((item) => !!item.finalizedBy) && productionPositionsLoading) {
      toast({
        title: "Production positions are still loading",
        description: "The worker-to-position assignments must be loaded before Stock Entry can be saved.",
        variant: "destructive",
      });
      return;
    }
    for (const item of cart) {
      if (!item.finalizedBy) continue;
      const eligible = eligibleProductionPositions(productionPositions, item.finalizedBy);
      const selectedId = productionPositionByProduct[item.productId] ?? null;
      const selectedIsValid = selectedId != null && eligible.some((position) => position.id === selectedId);
      if (eligible.length > 1 && !selectedIsValid) {
        toast({
          title: "Production Position required",
          description: `${item.product.name} is assigned to a worker who belongs to multiple production positions. Choose the correct position first.`,
          variant: "destructive",
        });
        return;
      }
      if (selectedId != null && !selectedIsValid) {
        toast({
          title: "Production Position changed",
          description: `The saved position for ${item.product.name} is no longer valid on ${entryDate}. Choose it again.`,
          variant: "destructive",
        });
        return;
      }
    }
    setConfirmDialogOpen(true);
  };

  const [designPickerOpen, setDesignPickerOpen] = useState(false);
  const [pendingPrintLabels, setPendingPrintLabels] = useState<LabelData[] | null>(null);
  const preOpenedWindowsRef = useRef<{ a4: Window | null; sticker: Window | null } | null>(null);

  const stockEntryMutation = useMutation({
    mutationFn: async () => {
      const response = await modeApiRequest("POST", "/api/factory/stock-entry", {
        erpLocationId: parseInt(selectedLocationId),
        items: cart.map((item) => ({
          productId: item.productId,
          qty: item.qty,
          weightPerBaleKg: item.weightPerBaleKg,
          finalizedBy: item.finalizedBy,
          productionPositionId: productionPositionByProduct[item.productId] ?? null,
        })),
        entryDate,
        customerId: selectedCustomerId !== "none" ? parseInt(selectedCustomerId) : null,
        logoId: selectedLogoId,
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.message || "Failed to record stock entry");
      }
      return await response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/stock-entry/in-stock"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales/daily-summary"] });
      toast({ title: "Stock Entry Recorded", description: `${totalQty} bale(s) added to inventory.` });
      printLabels(data.bales, cart, baleProducts, selectedLogoId, modeApiRequest, toast, preOpenedWindowsRef);
      setCart([]);
      setProductionPositionByProduct({});
      setConfirmDialogOpen(false);
      discardCartDraft();
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
      <div className="xl:col-span-8 space-y-4">
        <Card className="border-none shadow-none bg-transparent">
          <CardHeader className="px-0 pt-0 pb-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-2">
                <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-primary/10 text-primary">
                  <Package className="h-4 w-4" />
                </div>
                <CardTitle className="text-base font-bold">New Production Entry</CardTitle>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs font-semibold gap-1.5"
                  onClick={() => {
                    setAdminAuthOpen(true);
                    setPendingCreateName("");
                  }}
                  data-testid="button-quick-create"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Quick Create Product
                </Button>
                {hasCartDraft && (
                  <DraftRestorePrompt
                    draftAge={cartDraftAge ?? ""}
                    onRestore={() => {
                      const draftData = cartDraft?.data as
                        | {
                            cart?: CartItem[];
                            productionPositionByProduct?: Record<number, number | null>;
                            selectedLocationId?: string;
                            entryDate?: string;
                            selectedCustomerId?: string;
                            selectedLogoId?: number | null;
                          }
                        | undefined;
                      if (draftData?.cart) {
                        const restored = draftData.cart
                          .map((i) => {
                            const p = baleProducts?.find((bp) => bp.id === i.productId);
                            return {
                              ...i,
                              finalizedBy: i.finalizedBy ?? null,
                              overrideLogoId: i.overrideLogoId ?? null,
                              product: p,
                            };
                          })
                          .filter((i): i is CartItem => !!i.product);
                        setCart(restored);
                      }
                      if (draftData?.productionPositionByProduct) {
                        setProductionPositionByProduct(draftData.productionPositionByProduct);
                      }
                      if (draftData?.selectedLocationId) setSelectedLocationId(draftData.selectedLocationId);
                      if (draftData?.entryDate) setEntryDate(draftData.entryDate);
                      if (draftData?.selectedCustomerId) setSelectedCustomerId(draftData.selectedCustomerId);
                      if (draftData && "selectedLogoId" in draftData)
                        setSelectedLogoId(draftData.selectedLogoId ?? null);
                      discardCartDraft();
                    }}
                    onDiscard={discardCartDraft}
                  />
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="px-0 space-y-4">
            <StockEntryScanner
              scanRef={scanRef}
              scanInput={scanInput}
              onScanInputChange={(val) => {
                setScanInput(val);
                setShowDropdown(true);
              }}
              onScanKeyDown={handleScanKeyDown}
              scanError={scanError}
              showDropdown={showDropdown}
              filteredProducts={filteredProducts}
              onSelectProduct={selectProduct}
            />

            <StockEntryCart
              cart={cart}
              workers={workers}
              workerCategoryFilter={workerCategoryFilter}
              onUpdateQty={updateQty}
              onSetQty={setQty}
              onUpdateWeight={updateWeight}
              onRemoveItem={removeItem}
              onAssignWorker={assignWorker}
              onSetLogoOverride={setLogoOverride}
              allCustomers={allCustomers}
              logoPickerOpen={logoPickerOpen}
              onLogoPickerOpenChange={setLogoPickerOpen}
              filteredWorkers={filteredWorkers}
            />

            <StockEntryProductionPositions
              cart={cart}
              workers={workers}
              positions={productionPositions}
              selectedByProduct={productionPositionByProduct}
              onSelect={assignProductionPosition}
            />
          </CardContent>
        </Card>
      </div>

      <div className="xl:col-span-4 space-y-6">
        <StockEntrySidebar
          selectedLocationId={selectedLocationId}
          onLocationChange={setSelectedLocationId}
          activeLocations={activeLocations || []}
          entryDate={entryDate}
          onEntryDateChange={setEntryDate}
          workerCategoryFilter={workerCategoryFilter}
          onWorkerCategoryFilterChange={(val) => {
            setWorkerCategoryFilter(val);
            setWorkerCategoryFilterManual(true);
          }}
          workerCategoryGroups={workerCategoryGroups}
          selectedCustomerId={selectedCustomerId}
          onCustomerIdChange={setSelectedCustomerId}
          allCustomers={allCustomers}
          totalQty={totalQty}
          totalKg={totalKg}
          isPending={stockEntryMutation.isPending}
          onConfirm={handleConfirmClick}
        />
      </div>

      <ConfirmStockEntryDialog
        open={confirmDialogOpen}
        onOpenChange={setConfirmDialogOpen}
        cart={cart}
        entryDate={entryDate}
        totalQty={totalQty}
        totalKg={totalKg}
        selectedLogoId={selectedLogoId}
        isPending={stockEntryMutation.isPending}
        onConfirm={() => {
          preOpenedWindowsRef.current = {
            a4: window.open("", "_blank"),
            sticker: window.open("", "_blank"),
          };
          stockEntryMutation.mutate();
        }}
      />

      <QuickCreateProductDialog
        open={quickCreateOpen}
        onOpenChange={setQuickCreateOpen}
        grade={quickCreateGrade}
        onGradeChange={setQuickCreateGrade}
        name={quickCreateName}
        onNameChange={setQuickCreateName}
        categoryId={quickCreateCategoryId}
        onCategoryChange={setQuickCreateCategoryId}
        weight={quickCreateWeight}
        onWeightChange={setQuickCreateWeight}
        activeCategories={activeCategories}
        isPending={quickCreateMutation.isPending}
        onSubmit={() => quickCreateMutation.mutate()}
      />

      <AdminAuthDialog
        open={adminAuthOpen}
        onOpenChange={(open) => {
          setAdminAuthOpen(open);
          if (!open) setPendingCreateName("");
        }}
        action="create a new bale product"
        onAuthorized={(credentials) => {
          setPendingAdminAuth(credentials);
          setAdminAuthOpen(false);
          setQuickCreateName(pendingCreateName);
          setQuickCreateOpen(true);
        }}
      />

      <DesignPickerDialog
        open={designPickerOpen}
        onOpenChange={(open) => {
          if (!open) {
            setDesignPickerOpen(false);
            setPendingPrintLabels(null);
          }
        }}
        designColors={designColors}
        onSelect={(color) => {
          setDesignPickerOpen(false);
          if (pendingPrintLabels) {
            const labels = pendingPrintLabels;
            setPendingPrintLabels(null);
            openBrowserPrint(labels, color, preOpenedWindowsRef);
          }
        }}
        onNoDesign={() => {
          setDesignPickerOpen(false);
          if (pendingPrintLabels) {
            const labels = pendingPrintLabels;
            setPendingPrintLabels(null);
            prefetchBannersForPrint();
            const paperFormat = getPaperFormat();
            const labelHtml = paperFormat === "A5" ? generateA5LabelsHtml(labels) : generateCombinedLabelsHtml(labels);
            const win = window.open("", "_blank");
            if (win) {
              win.document.write(labelHtml);
              win.document.close();
              win.focus();
              setTimeout(() => win.print(), 500);
            }
          }
        }}
      />
    </div>
  );
}
