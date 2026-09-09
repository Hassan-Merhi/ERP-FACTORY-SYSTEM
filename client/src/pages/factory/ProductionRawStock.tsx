import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useMemo, useRef } from "react";
import { useAdminOverride } from "@/hooks/use-admin-override";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useQuery, useMutation } from "@tanstack/react-query";
import { FlaskConical, ArrowDown, Tag, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import type { FactoryMixBatch } from "@shared/schema";

import { SupplierCategoriesDialog } from "./production-raw-stock/ProductionRawStockHelpers";
import { RawStockTable } from "./production-raw-stock/RawStockTable";
import { MixBatchList } from "./production-raw-stock/MixBatchList";
import { KpiCards } from "./production-raw-stock/KpiCards";
import { OffloadDialog } from "./production-raw-stock/OffloadDialog";
import { StockAdjustmentDialog } from "./production-raw-stock/StockAdjustmentDialog";
import { DeductStockDialog } from "./production-raw-stock/DeductStockDialog";
import { AddToBatchDialog } from "./production-raw-stock/AddToBatchDialog";
import { CreateMixBatchDialog } from "@/components/CreateMixBatchDialog";
import { EditMixBatchDialog } from "@/components/EditMixBatchDialog";

export default function ProductionRawStock() {
  const { wrapAdminAction, AdminDialog } = useAdminOverride();
  const { formatDisplayDate } = useDateFormat();
  const { toast } = useToast();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);

  const [offloadDialogOpen, setOffloadDialogOpen] = useState(false);
  const [categoriesDialogOpen, setCategoriesDialogOpen] = useState(false);
  const [adjustDialogOpen, setAdjustDialogOpen] = useState(false);
  const [deductDialogOpen, setDeductDialogOpen] = useState(false);
  const [addToBatchOpen, setAddToBatchOpen] = useState(false);
  const [createMixBatchOpen, setCreateMixBatchOpen] = useState(false);
  const [editBatch, setEditBatch] = useState<FactoryMixBatch | null>(null);

  const [adjustingRow, setAdjustingRow] = useState<any>(null);
  const [adjIsNewMaterial, setAdjIsNewMaterial] = useState(false);
  const [deductingRow, setDeductingRow] = useState<any>(null);
  const [addToBatchSource, setAddToBatchSource] = useState<any>(null);
  const [mixBatchDate, setMixBatchDate] = useState(() => new Date().toISOString().substring(0, 10));

  const mixBatchPrintRef = useRef<HTMLDivElement>(null);

  const { data: rawStock, isLoading: _rawStockLoading } = useQuery<any[]>({
    queryKey: ["/api/factory/raw-stock"],
  });

  const { data: mixBatches, isLoading: mixBatchesLoading } = useQuery<any[]>({
    queryKey: ["/api/factory/mix-batches"],
  });

  const { data: factorySuppliers = [] } = useQuery<any[]>({
    queryKey: ["/api/factory/suppliers"],
  });

  const { data: ledgerAccounts = [] } = useQuery<any[]>({
    queryKey: ["/api/ledger-accounts?includeHidden=true"],
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const { data: availableContainersRaw = [] } = useQuery<any[]>({
    queryKey: ["/api/factory/raw-stock/available-containers"],
  });
  const availableContainers = availableContainersRaw.filter((c) => c.status !== "PARTIALLY_RECEIVED");

  const { data: mixBatchesByDate = [], isLoading: mixBatchesByDateLoading } = useQuery<any[]>({
    queryKey: [`/api/factory/mix-batches-by-date?date=${encodeURIComponent(mixBatchDate)}`],
    enabled: !!mixBatchDate,
  });

  const offloadMutation = useMutation({
    mutationFn: async (data) => {
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
    mutationFn: async (payload) => {
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
    mutationFn: async (payload) => {
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

  const updateCostMutation = useMutation({
    mutationFn: async (payload) => {
      const res = await modeApiRequest("POST", "/api/factory/raw-stock/update-cost", payload);
      if (!res.ok) throw new Error((await res.json()).message || "Failed to update cost");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock"] });
      setAdjustDialogOpen(false);
      toast({ title: "Cost Updated", description: "Cost updated successfully." });
    },
  });

  const addToBatchMutation = useMutation({
    mutationFn: async (data: any) => {
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
    const totalUsed = rs.reduce((sum, r) => sum + parseFloat(r.usedKg || "0"), 0);
    return {
      totalReceived: rs.reduce((sum, r) => sum + parseFloat(r.receivedKg || "0"), 0),
      totalReceivedValue: rs.reduce(
        (sum, r) => sum + parseFloat(r.receivedKg || "0") * parseFloat(r.costPerKgUsd || r.costPerKg || "0"),
        0
      ),
      totalUsed,
      totalUsedValue: rs.reduce((sum, r) => sum + parseFloat(r.usedValueUsd || "0"), 0),
      totalFree: rs.reduce((sum, r) => sum + parseFloat(r.freeKg || "0"), 0),
      totalValue: rs.reduce((sum, r) => sum + parseFloat(r.valueRemainingUsd || r.valueRemaining || "0"), 0),
    };
  }, [rawStock]);

  return (
    <div className="min-w-0 space-y-4 p-3 sm:space-y-6 sm:p-6" data-testid="production-raw-stock-page">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-amber-500/25 bg-gradient-to-br from-amber-500/30 to-amber-600/10">
            <FlaskConical className="h-4.5 w-4.5 text-amber-500" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-bold leading-tight">Raw Production</h1>
            <p className="text-xs leading-tight text-muted-foreground">
              Raw stock inventory and daily mix batch management
            </p>
          </div>
        </div>
        <div className="grid w-full grid-cols-1 gap-2 min-[360px]:grid-cols-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center sm:justify-end">
          <Button
            onClick={() => setCreateMixBatchOpen(true)}
            className="h-11 gap-2 rounded-lg bg-blue-600 px-3 text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:bg-blue-700 hover:shadow-md dark:bg-blue-500 dark:hover:bg-blue-400 sm:h-9"
            data-testid="button-create-mix-batch"
          >
            <Layers className="h-4 w-4" /> <span className="hidden sm:inline">New Mix Batch</span>
            <span className="sm:hidden">New Batch</span>
          </Button>
          <Button
            onClick={() => setOffloadDialogOpen(true)}
            className="h-11 gap-2 rounded-lg bg-emerald-600 px-3 text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:bg-emerald-700 hover:shadow-md dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400 sm:h-9"
            data-testid="button-offload-container"
          >
            <ArrowDown className="h-4 w-4" /> Offload Container
          </Button>
          <Button
            variant="outline"
            onClick={() => setCategoriesDialogOpen(true)}
            className="h-11 gap-2 rounded-lg border-amber-500/40 bg-amber-500/5 px-3 text-xs font-semibold text-amber-700 shadow-sm transition-all hover:-translate-y-0.5 hover:border-amber-500/60 hover:bg-amber-500/10 hover:shadow-md dark:text-amber-300 min-[360px]:col-span-2 sm:h-9 sm:w-auto"
            data-testid="button-manage-categories"
          >
            <Tag className="h-4 w-4" /> Categories
          </Button>
        </div>
      </div>

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
            formatDisplayDate={formatDisplayDate}
          />
        </section>
      </div>

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
        updateCostMutation={updateCostMutation}
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
