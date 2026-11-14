import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useMemo, useRef } from "react";
import { useAdminOverride } from "@/hooks/use-admin-override";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useQuery, useMutation } from "@tanstack/react-query";
import { FlaskConical, ArrowDown, Tag, Layers, Calculator } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { queryClient } from "@/lib/queryClient";
import { useAppMode } from "@/contexts/AppModeContext";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { translateFixedProductionPlanner } from "@/i18n/fixedProductionPlannerTranslations";
import { getApiRequest } from "@/lib/factoryApi";
import type { FactoryMixBatch } from "@shared/schema";

import { SupplierCategoriesDialog } from "./production-raw-stock/ProductionRawStockHelpers";
import { RawStockTable, type RawStockRow } from "./production-raw-stock/RawStockTable";
import { MixBatchList, type MixBatchPrintRow, type MixBatchRow } from "./production-raw-stock/MixBatchList";
import type { MixBatchSupplierCategory } from "./production-raw-stock/mixBatchCategoryTargets";
import { KpiCards } from "./production-raw-stock/KpiCards";
import { OffloadDialog } from "./production-raw-stock/OffloadDialog";
import { FixedProductionPlannerDialog } from "./production-raw-stock/FixedProductionPlannerDialog";
import type {
  OffloadContainer,
  OffloadLedgerAccount,
  OffloadPayload,
  OffloadSupplierOption,
} from "./production-raw-stock/offloadDialogTypes";
import { StockAdjustmentDialog, type StockAdjustmentPayload } from "./production-raw-stock/StockAdjustmentDialog";
import { DeductStockDialog, type DeductStockPayload } from "./production-raw-stock/DeductStockDialog";
import { AddToBatchDialog, type AddToBatchSource } from "./production-raw-stock/AddToBatchDialog";
import { CreateMixBatchDialog } from "@/components/CreateMixBatchDialog";
import { EditMixBatchDialog } from "@/components/EditMixBatchDialog";

interface AddToBatchPayload {
  batchId: number;
  supplierId: number;
  weightKg: string;
}

export default function ProductionRawStock() {
  const { wrapAdminAction, AdminDialog } = useAdminOverride();
  const { formatDisplayDate } = useDateFormat();
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();
  const appMode = useAppMode();
  const { language } = useApplicationLanguage();
  const modeApiRequest = getApiRequest(appMode);

  const [offloadDialogOpen, setOffloadDialogOpen] = useState(false);
  const [fixedPlannerOpen, setFixedPlannerOpen] = useState(false);
  const [categoriesDialogOpen, setCategoriesDialogOpen] = useState(false);
  const [adjustDialogOpen, setAdjustDialogOpen] = useState(false);
  const [deductDialogOpen, setDeductDialogOpen] = useState(false);
  const [addToBatchOpen, setAddToBatchOpen] = useState(false);
  const [createMixBatchOpen, setCreateMixBatchOpen] = useState(false);
  const [editBatch, setEditBatch] = useState<FactoryMixBatch | null>(null);

  const [adjustingRow, setAdjustingRow] = useState<RawStockRow | null>(null);
  const [adjIsNewMaterial, setAdjIsNewMaterial] = useState(false);
  const [deductingRow, setDeductingRow] = useState<RawStockRow | null>(null);
  const [addToBatchSource, setAddToBatchSource] = useState<AddToBatchSource | null>(null);
  const [mixBatchDate, setMixBatchDate] = useState(() => new Date().toISOString().substring(0, 10));

  const mixBatchPrintRef = useRef<HTMLDivElement>(null);

  const {
    data: rawStock,
    isFetching: rawStockLoading,
    isError: rawStockError,
  } = useQuery<RawStockRow[]>({
    queryKey: ["/api/factory/raw-stock"],
  });

  const { data: mixBatches, isLoading: mixBatchesLoading } = useQuery<MixBatchRow[]>({
    queryKey: ["/api/factory/mix-batches"],
  });

  const {
    data: factorySuppliers = [],
    isFetching: suppliersLoading,
    isError: suppliersError,
  } = useQuery<OffloadSupplierOption[]>({
    queryKey: ["/api/factory/suppliers"],
  });

  const { data: ledgerAccounts = [] } = useQuery<OffloadLedgerAccount[]>({
    queryKey: ["/api/ledger-accounts?includeHidden=true&profile=picker"],
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const { data: availableContainersRaw = [] } = useQuery<OffloadContainer[]>({
    queryKey: ["/api/factory/raw-stock/available-containers"],
  });
  const availableContainers = availableContainersRaw.filter((c) => c.status !== "PARTIALLY_RECEIVED");

  const { data: mixBatchesByDate = [], isLoading: mixBatchesByDateLoading } = useQuery<MixBatchPrintRow[]>({
    queryKey: [`/api/factory/mix-batches-by-date?date=${encodeURIComponent(mixBatchDate)}`],
    enabled: !!mixBatchDate,
  });

  const {
    data: reportCategories = [],
    isLoading: reportCategoriesLoading,
    isError: reportCategoriesError,
  } = useQuery<MixBatchSupplierCategory[]>({
    queryKey: ["/api/factory/supplier-categories"],
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const {
    data: fixedProductionPlan,
    isLoading: fixedProductionPlanLoading,
    isError: fixedProductionPlanError,
  } = useQuery<{ allocations20t: Record<string, number>; revision: number; locked: boolean }>({
    queryKey: ["/api/factory/raw-stock/fixed-production-planner"],
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const reportAllocations =
    fixedProductionPlan && fixedProductionPlan.revision > 0 ? fixedProductionPlan.allocations20t : null;
  const reportLoading =
    mixBatchesByDateLoading ||
    reportCategoriesLoading ||
    suppliersLoading ||
    fixedProductionPlanLoading ||
    reportCategoriesError ||
    suppliersError ||
    fixedProductionPlanError;

  const offloadMutation = useMutation({
    mutationFn: async (data: OffloadPayload) => {
      const res = await modeApiRequest("POST", "/api/factory/raw-stock/offload", data);
      if (!res.ok) throw new Error((await res.json()).message || "Failed to offload");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock/available-containers"] });
      setOffloadDialogOpen(false);
      toast({ title: "Success", description: "Container offloaded successfully." });
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({
        title: "Offload Failed",
        description: error?.message || "Could not offload container. Please check your inputs and try again.",
        variant: "destructive",
      });
    },
  });

  const createAdjustmentMutation = useMutation({
    mutationFn: async (payload: StockAdjustmentPayload) => {
      const res = await modeApiRequest("POST", "/api/factory/raw-stock/adjustment", payload);
      if (!res.ok) throw new Error((await res.json()).message || "Failed to save adjustment");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock"] });
      setAdjustDialogOpen(false);
      toast({ title: "Saved", description: "Stock adjustment recorded." });
    },
  });

  const deductReceivedMutation = useMutation({
    mutationFn: async (payload: DeductStockPayload) => {
      const res = await modeApiRequest("POST", "/api/factory/raw-stock/deduct-received", payload);
      if (!res.ok) throw new Error((await res.json()).message || "Failed to deduct");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock"] });
      setDeductDialogOpen(false);
      toast({ title: "Deducted", description: "Stock deducted successfully." });
    },
  });

  const addToBatchMutation = useMutation({
    mutationFn: async (data: AddToBatchPayload) => {
      const res = await modeApiRequest("POST", `/api/factory/mix-batches/${data.batchId}/top-up`, {
        supplierSources: [{ supplierId: data.supplierId, weightKg: data.weightKg }],
      });
      if (!res.ok) throw new Error((await res.json()).message || "Failed to add to batch");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/mix-batches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock"] });
      setAddToBatchOpen(false);
      toast({ title: "Success", description: "Added to batch successfully." });
    },
  });

  const deleteMixBatchMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await modeApiRequest("DELETE", `/api/factory/mix-batches/${id}`);
      if (!res.ok) throw new Error((await res.json()).message || "Failed to delete batch");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/mix-batches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock"] });
      toast({ title: "Deleted", description: "Mix batch deleted." });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const sendWhatsAppMutation = useMutation({
    mutationFn: async () => {
      if (!mixBatchPrintRef.current) throw new Error("Nothing to capture");
      if (!reportAllocations || reportLoading)
        throw new Error("Save a Fixed Production Plan before sending a target comparison.");
      const html2canvas = (await import("html2canvas")).default;
      const canvas = await html2canvas(mixBatchPrintRef.current, { backgroundColor: "#111827", scale: 2 });
      const imageBase64 = canvas.toDataURL("image/png");
      const res = await modeApiRequest("POST", "/api/factory/send-mix-batch-image-whatsapp", {
        imageBase64,
        date: mixBatchDate,
        fileName: `MixBatch_${mixBatchDate}.png`,
      });
      if (!res.ok) throw new Error((await res.json()).message || "Failed to send");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Sent", description: "Mix batch details sent to WhatsApp group." });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const kpiData = useMemo(() => {
    const rs = rawStock || [];
    const originalBatches = (mixBatches || []).filter((batch) => batch.carryForwardFromId == null);

    // Keep the Raw Production "Total Used" KPI on the exact same stored batch basis
    // as Production Overview -> Original Batches. Raw-stock rows can legitimately omit
    // historical suppliers that no longer have a current stock/adjustment row, while
    // mix-batch totals remain the authoritative historical usage/value record.
    const totalUsed = originalBatches.reduce((sum, batch) => sum + (parseFloat(batch.totalWeightKg || "0") || 0), 0);
    const totalUsedValue = originalBatches.reduce((sum, batch) => sum + (parseFloat(batch.totalCost || "0") || 0), 0);

    return {
      totalReceived: rs.reduce((sum, r) => sum + parseFloat(r.receivedKg || "0"), 0),
      totalReceivedValue: rs.reduce(
        (sum, r) => sum + parseFloat(r.receivedKg || "0") * parseFloat(r.costPerKgUsd || r.costPerKg || "0"),
        0
      ),
      totalUsed,
      totalUsedValue,
      totalFree: rs.reduce((sum, r) => sum + parseFloat(r.freeKg || "0"), 0),
      totalValue: rs.reduce((sum, r) => sum + parseFloat(r.valueRemainingUsd || r.valueRemaining || "0"), 0),
    };
  }, [rawStock, mixBatches]);

  return (
    <div className="min-w-0 space-y-4 p-3 sm:space-y-6 sm:p-6" data-testid="production-raw-stock-page">
      <PageHeader
        title="Raw Production"
        subtitle="Raw stock inventory and daily mix batch management"
        icon={<FlaskConical className="h-5 w-5" />}
      >
        <Button
          variant="outline"
          onClick={() => setFixedPlannerOpen(true)}
          className="h-11 gap-2 rounded-xl border-blue-300/60 bg-card/80 px-3 text-xs font-semibold shadow-sm transition-colors hover:border-blue-500/50 hover:bg-blue-500/5 dark:border-blue-400/25 sm:h-10"
          data-testid="button-fixed-production-planner"
        >
          <Calculator className="h-4 w-4" /> {translateFixedProductionPlanner("title", language)}
        </Button>
        {!recordChanges.isCreateOnly && (
          <Button
            onClick={() => setCreateMixBatchOpen(true)}
            className="h-11 gap-2 rounded-xl bg-blue-600 px-3 text-xs font-bold text-white shadow-sm shadow-blue-500/20 transition-all hover:-translate-y-0.5 hover:bg-blue-700 hover:shadow-md dark:bg-blue-500 dark:text-white dark:hover:bg-blue-400 sm:h-10"
            data-testid="button-create-mix-batch"
          >
            <Layers className="h-4 w-4" /> <span className="hidden sm:inline">New Mix Batch</span>
            <span className="sm:hidden">New Batch</span>
          </Button>
        )}
        {recordChanges.allowed && (
          <Button
            onClick={() => setOffloadDialogOpen(true)}
            className="h-11 gap-2 rounded-xl bg-emerald-600 px-3 text-xs font-bold text-white shadow-sm shadow-emerald-500/20 transition-all hover:-translate-y-0.5 hover:bg-emerald-700 hover:shadow-md dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400 sm:h-10"
            data-testid="button-offload-container"
          >
            <ArrowDown className="h-4 w-4" /> Offload Container
          </Button>
        )}
        {recordChanges.allowed && (
          <Button
            variant="outline"
            onClick={() => setCategoriesDialogOpen(true)}
            className="h-11 gap-2 rounded-xl border-amber-500/40 bg-amber-500/5 px-3 text-xs font-bold text-amber-700 shadow-sm transition-all hover:-translate-y-0.5 hover:border-amber-500/70 hover:bg-amber-500/10 hover:shadow-md dark:text-amber-300 min-[360px]:col-span-2 sm:h-10 sm:w-auto"
            data-testid="button-manage-categories"
          >
            <Tag className="h-4 w-4" /> Categories
          </Button>
        )}
      </PageHeader>

      <KpiCards {...kpiData} />

      <div className="grid min-w-0 gap-4 sm:gap-6">
        <section className="min-w-0 space-y-4">
          <RawStockTable
            rawStock={rawStock || []}
            onAdjust={(row) => {
              setAdjIsNewMaterial(false);
              setAdjustingRow(row);
              setAdjustDialogOpen(true);
            }}
            onDeduct={(row) => {
              setDeductingRow(row);
              setDeductDialogOpen(true);
            }}
            onAddToBatch={(row) => {
              if (row.supplierId === null) return;
              setAddToBatchSource({
                supplierId: row.supplierId,
                supplierName: row.supplierName,
                costPerKg: String(parseFloat(row.costPerKgUsd || row.costPerKg || "0")),
                remainingKg: row.freeKg || row.remainingKg || "0",
              });
              setAddToBatchOpen(true);
            }}
            onNewMaterial={() => {
              setAdjIsNewMaterial(true);
              setAdjustingRow(null);
              setAdjustDialogOpen(true);
            }}
          />
        </section>

        <section className="min-w-0 space-y-4">
          <MixBatchList
            mixBatches={mixBatches || []}
            isLoading={mixBatchesLoading}
            onEdit={(batch) => setEditBatch(batch as unknown as FactoryMixBatch)}
            onDelete={(id) => deleteMixBatchMutation.mutate(id)}
            onViewDetail={(batch) => setEditBatch(batch as unknown as FactoryMixBatch)}
            onSendWhatsApp={() => sendWhatsAppMutation.mutate()}
            isSendingWhatsApp={sendWhatsAppMutation.isPending}
            mixBatchDate={mixBatchDate}
            setMixBatchDate={setMixBatchDate}
            mixBatchesByDate={mixBatchesByDate}
            mixBatchesByDateLoading={mixBatchesByDateLoading}
            mixBatchPrintRef={mixBatchPrintRef}
            reportCategories={reportCategories}
            reportSuppliers={factorySuppliers}
            reportAllocations={reportAllocations}
            reportLoading={reportLoading}
            formatDisplayDate={formatDisplayDate}
          />
        </section>
      </div>

      <FixedProductionPlannerDialog
        open={fixedPlannerOpen}
        onOpenChange={setFixedPlannerOpen}
        rawStock={rawStock || []}
        rawStockLoading={rawStockLoading}
        rawStockError={rawStockError}
        suppliers={factorySuppliers}
        suppliersLoading={suppliersLoading}
        suppliersError={suppliersError}
      />

      <CreateMixBatchDialog
        open={createMixBatchOpen}
        onOpenChange={setCreateMixBatchOpen}
        onCreated={() => {
          queryClient.invalidateQueries({ queryKey: ["/api/factory/mix-batches"] });
          queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock"] });
        }}
      />

      <EditMixBatchDialog
        batch={editBatch}
        open={editBatch !== null}
        onOpenChange={(open) => {
          if (!open) setEditBatch(null);
        }}
      />

      <OffloadDialog
        open={offloadDialogOpen}
        onOpenChange={setOffloadDialogOpen}
        availableContainers={availableContainers}
        factorySuppliers={factorySuppliers}
        ledgerAccounts={ledgerAccounts}
        offloadMutation={offloadMutation}
        wrapAdminAction={wrapAdminAction}
        mixBatches={mixBatches || []}
      />

      <StockAdjustmentDialog
        open={adjustDialogOpen}
        onOpenChange={setAdjustDialogOpen}
        adjustingRow={adjustingRow}
        isNewMaterial={adjIsNewMaterial}
        factorySuppliers={factorySuppliers}
        createAdjustmentMutation={createAdjustmentMutation}
        wrapAdminAction={wrapAdminAction}
      />

      <DeductStockDialog
        open={deductDialogOpen}
        onOpenChange={setDeductDialogOpen}
        deductingRow={deductingRow}
        deductReceivedMutation={deductReceivedMutation}
        wrapAdminAction={wrapAdminAction}
      />

      <AddToBatchDialog
        open={addToBatchOpen}
        onOpenChange={setAddToBatchOpen}
        addToBatchSource={addToBatchSource}
        setAddToBatchSource={setAddToBatchSource}
        mixBatches={mixBatches || []}
        rawStock={rawStock || []}
        addToBatchMutation={addToBatchMutation}
        wrapAdminAction={wrapAdminAction}
      />

      <SupplierCategoriesDialog open={categoriesDialogOpen} onClose={() => setCategoriesDialogOpen(false)} />

      {AdminDialog}
    </div>
  );
}
