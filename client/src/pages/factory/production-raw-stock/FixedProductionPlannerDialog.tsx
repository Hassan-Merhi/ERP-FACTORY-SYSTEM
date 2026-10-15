import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Calculator, Download, Loader2, Lock, LockOpen, MessageCircle, RefreshCw, Save } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { translateFixedProductionPlanner, translateFixedPlannerApiMessage, type FixedProductionPlannerTranslationKey } from "@/i18n/fixedProductionPlannerTranslations";
import { formatNumber } from "@/lib/formatNumber";
import { getApiRequest } from "@/lib/factoryApi";
import { queryClient } from "@/lib/queryClient";
import type { RawStockRow } from "./RawStockTable";
import type { OffloadSupplierOption } from "./offloadDialogTypes";
import { FixedProductionPlannerImage } from "./FixedProductionPlannerImage";
import { calculateFixedProductionRows, sumFixedProductionRows } from "./fixedProductionPlannerCalculations";

interface FixedProductionPlannerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rawStock: RawStockRow[];
  rawStockLoading: boolean;
  rawStockError: boolean;
  suppliers: OffloadSupplierOption[];
  suppliersLoading: boolean;
  suppliersError: boolean;
}

interface PlannerRecord {
  allocations20t: Record<string, number>;
  locked: boolean;
  revision: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

interface OtwContainer {
  id: number;
  supplierId: number | null;
  totalKg: string | null;
  status: string;
}

const PLAN_KEY = ["/api/factory/raw-stock/fixed-production-planner"] as const;
const OTW_KEY = ["/api/factory/containers?activeOnly=true"] as const;
const apiRequest = getApiRequest("factory");

function displayKg(value: number): string {
  return formatNumber(value, 3);
}

export function FixedProductionPlannerDialog({
  open, onOpenChange, rawStock, rawStockLoading, rawStockError, suppliers, suppliersLoading, suppliersError,
}: FixedProductionPlannerDialogProps) {
  const { toast } = useToast();
  const { language } = useApplicationLanguage();
  const tr = (key: FixedProductionPlannerTranslationKey, params?: Record<string, string | number>) => translateFixedProductionPlanner(key, language, params);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [hasEdits, setHasEdits] = useState(false);
  const reportRef = useRef<HTMLDivElement>(null);

  const planQuery = useQuery<PlannerRecord>({
    queryKey: [...PLAN_KEY],
    enabled: open,
    queryFn: async () => {
      const res = await apiRequest("GET", PLAN_KEY[0]);
      return res.json();
    },
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
  const otwQuery = useQuery<OtwContainer[]>({
    queryKey: [...OTW_KEY],
    enabled: open,
    queryFn: async () => {
      const res = await apiRequest("GET", OTW_KEY[0]);
      return res.json();
    },
    refetchOnWindowFocus: false,
    staleTime: 0,
  });

  useEffect(() => {
    if (!open || !planQuery.data || hasEdits) return;
    setInputs(Object.fromEntries(
      Object.entries(planQuery.data.allocations20t || {}).map(([id, qty]) => [id, String(qty)])
    ));
  }, [open, planQuery.data, hasEdits]);

  // Discard unsaved changes when closing: reopening loads the last saved plan.
  useEffect(() => {
    if (!open) setHasEdits(false);
  }, [open]);

  const saveMutation = useMutation({
    mutationFn: async (allocations20t: Record<string, number>) => {
      const res = await apiRequest("POST", PLAN_KEY[0] + "/save", {
        allocations20t,
        expectedRevision: planQuery.data?.revision ?? 0,
      });
      return res.json() as Promise<PlannerRecord>;
    },
    onSuccess: async (saved) => {
      setInputs(Object.fromEntries(Object.entries(saved.allocations20t).map(([id, v]) => [id, String(v)])));
      setHasEdits(false);
      await queryClient.invalidateQueries({ queryKey: [...PLAN_KEY] });
      toast({ title: tr("savedTitle"), description: tr("savedInfo") });
    },
    onError: (err: Error) => toast({ title: tr("saveError"), description: translateFixedPlannerApiMessage(err.message, language), variant: "destructive" }),
  });

  const unlockMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", PLAN_KEY[0] + "/unlock", {
        expectedRevision: planQuery.data?.revision,
      });
      return res.json() as Promise<PlannerRecord>;
    },
    onSuccess: async () => {
      setHasEdits(false);
      await queryClient.invalidateQueries({ queryKey: [...PLAN_KEY] });
      toast({ title: tr("unlockedTitle"), description: tr("unlockedInfo") });
    },
    onError: (err: Error) => toast({ title: tr("unlockError"), description: translateFixedPlannerApiMessage(err.message, language), variant: "destructive" }),
  });

  const rows = useMemo(
    () => calculateFixedProductionRows(suppliers, rawStock, otwQuery.data ?? [], inputs),
    [suppliers, rawStock, otwQuery.data, inputs],
  );
  const totals = useMemo(() => sumFixedProductionRows(rows), [rows]);

  // WhatsApp images always use saved allocations, never unsaved edits.
  const reportRows = useMemo(
    () => calculateFixedProductionRows(suppliers, rawStock, otwQuery.data ?? [], planQuery.data?.allocations20t ?? {}),
    [suppliers, rawStock, otwQuery.data, planQuery.data?.allocations20t],
  );
  const reportTotals = useMemo(() => sumFixedProductionRows(reportRows), [reportRows]);

  const reportDate = (() => {
    const now = new Date();
    return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
  })();
  const reportDateLabel = reportDate.split("-").reverse().join("/");

  const captureImage = async (): Promise<string> => {
    if (!reportRef.current) throw new Error(tr("imageNotReady"));
    const html2canvas = (await import("html2canvas")).default;
    const canvas = await html2canvas(reportRef.current, {
      backgroundColor: "#ffffff",
      scale: 2,
      logging: false,
      useCORS: true,
    });
    return canvas.toDataURL("image/png");
  };

  const whatsappMutation = useMutation({
    mutationFn: async () => {
      const imageBase64 = await captureImage();
      const res = await apiRequest("POST", "/api/factory/send-mix-batch-image-whatsapp", {
        imageBase64,
        date: reportDate,
        fileName: `FixedProductionPlan_${reportDate}.png`,
        caption: tr("reportCaption", { date: reportDateLabel }),
        reportLabel: tr("title"),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || tr("sendErrorInfo"));
      }
      return res.json();
    },
    onSuccess: () => toast({ title: tr("sendSuccess") }),
    onError: (error: Error) => toast({ title: tr("sendError"), description: translateFixedPlannerApiMessage(error.message, language), variant: "destructive" }),
  });

  const downloadImage = async () => {
    try {
      const imageBase64 = await captureImage();
      const link = document.createElement("a");
      link.href = imageBase64;
      link.download = `FixedProductionPlan_${reportDate}.png`;
      link.click();
    } catch (error) {
      toast({ title: tr("downloadError"), description: error instanceof Error ? error.message : tr("unknownError"), variant: "destructive" });
    }
  };

  const locked = planQuery.data?.locked ?? false;
  const ready = !!planQuery.data && !!otwQuery.data && !planQuery.isFetching && !otwQuery.isFetching && !rawStockLoading && !rawStockError && !suppliersLoading && !suppliersError;
  const pending = saveMutation.isPending || unlockMutation.isPending || whatsappMutation.isPending;

  const saveAndLock = () => {
    if (locked || pending || !ready) return;
    const allocations: Record<string, number> = {};
    for (const row of rows) {
      const raw = inputs[row.id]?.trim() ?? "";
      const quantity = raw === "" ? 0 : Number(raw);
      if (!Number.isFinite(quantity) || quantity < 0 || !Number.isSafeInteger(Math.trunc(quantity)) ||
          !/^\d+(?:\.\d{1,3})?$/.test(raw || "0")) {
        toast({
          title: tr("invalidQuantity"),
          description: tr("invalidQuantityInfo", { name: row.name }),
          variant: "destructive",
        });
        return;
      }
      allocations[row.id] = quantity;
    }
    saveMutation.mutate(allocations);
  };

  return (
    <>
    <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next); }}>
      <DialogContent className="flex max-h-[92vh] w-[98vw] max-w-[1680px] flex-col gap-3 overflow-hidden p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <Calculator className="h-5 w-5 text-amber-500" /> {tr("title")}
          </DialogTitle>
          <DialogDescription>
            {tr("description")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {locked ? <Lock className="h-4 w-4 text-amber-500" /> : <LockOpen className="h-4 w-4 text-emerald-500" />}
            <span className="font-semibold">{locked ? tr("savedAndLocked") : tr("unlockedForEditing")}</span>
            {planQuery.data?.updatedAt && (
              <span className="text-muted-foreground">{tr("lastSaved", { date: new Date(planQuery.data.updatedAt).toLocaleString() })}</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" className="gap-1.5"
              disabled={!ready || !locked || reportRows.length === 0 || pending}
              onClick={() => { void downloadImage(); }}
              data-testid="button-fixed-production-download-image">
              <Download className="h-3.5 w-3.5" /> {tr("downloadPng")}
            </Button>
            <Button variant="outline" size="sm" className="gap-1.5"
              disabled={!ready || !locked || reportRows.length === 0 || pending}
              onClick={() => whatsappMutation.mutate()}
              data-testid="button-fixed-production-send-whatsapp">
              {whatsappMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageCircle className="h-3.5 w-3.5" />}
              {whatsappMutation.isPending ? tr("sending") : tr("sendWhatsapp")}
            </Button>
            <Button variant="outline" size="sm" onClick={() => {
              setHasEdits(false);
              void queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock"] });
              void queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] });
              void Promise.all([planQuery.refetch(), otwQuery.refetch()]);
            }} disabled={pending} className="gap-1.5">
              <RefreshCw className="h-3.5 w-3.5" /> {tr("refresh")}
            </Button>
            {locked ? (
              <Button size="sm" variant="outline" className="gap-1.5" disabled={!ready || pending}
                onClick={() => unlockMutation.mutate()}>
                <LockOpen className="h-3.5 w-3.5" /> {unlockMutation.isPending ? tr("unlocking") : tr("unlockToEdit")}
              </Button>
            ) : (
              <Button size="sm" className="gap-1.5" disabled={!ready || pending}
                onClick={saveAndLock}>
                <Save className="h-3.5 w-3.5" /> {saveMutation.isPending ? tr("saving") : tr("saveAndLock")}
              </Button>
            )}
          </div>
        </div>

        {planQuery.isError || otwQuery.isError || rawStockError || suppliersError ? (
          <div role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">
            {tr("loadError")}
          </div>
        ) : null}
        {!ready && !planQuery.isError && !otwQuery.isError && !rawStockError && !suppliersError ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{tr("loading")}</p>
        ) : (
          <div className="min-h-0 overflow-auto rounded-lg border">
            <table className="w-full min-w-[1470px] border-collapse text-sm tabular-nums">
              <thead className="sticky top-0 z-10 bg-muted text-xs uppercase">
                <tr>
                  <th className="border-b p-3 text-left">{tr("origin")}</th>
                  <th className="border-b p-3 text-right">{tr("inHand")}</th>
                  <th className="border-b p-3 text-right">{tr("otw")}</th>
                  <th className="border-b p-3 text-right">{tr("total")}</th>
                  <th className="border-b bg-sky-500/10 p-3 text-right">{tr("fifteenTons")}</th>
                  <th className="border-b bg-blue-500/10 p-3 text-right">{tr("seventeenTons")}</th>
                  <th className="border-b bg-amber-500/10 p-3 text-right">{tr("twentyTons")}</th>
                  <th className="border-b bg-emerald-500/10 p-3 text-right">{tr("withOtw")}</th>
                  <th className="border-b bg-slate-500/10 p-3 text-right">{tr("withoutOtw")}</th>
                  <th className="border-b bg-lime-500/10 p-3 text-right">{tr("containersToOrder")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b hover:bg-muted/30">
                    <td className="px-3 py-2 font-medium">{row.name}</td>
                    <td className="px-3 py-2 text-right">{displayKg(row.inHand)}</td>
                    <td className="px-3 py-2 text-right">{displayKg(row.otw)}</td>
                    <td className="px-3 py-2 text-right font-semibold">{displayKg(row.total)}</td>
                    <td className="bg-sky-500/5 px-3 py-2 text-right">{displayKg(row.allocation15)}</td>
                    <td className="bg-blue-500/5 px-3 py-2 text-right">{displayKg(row.allocation175)}</td>
                    <td className="bg-amber-500/5 px-3 py-1.5 text-right">
                      {locked ? (
                        <span className="font-semibold">{displayKg(row.allocation20)}</span>
                      ) : (
                        <Input type="number" inputMode="decimal" min="0" step="0.001"
                          aria-label={tr("allocationLabel", { name: row.name })}
                          data-testid={`fixed-production-20t-${row.id}`}
                          className="ml-auto h-8 w-32 text-right font-mono"
                          value={inputs[row.id] ?? ""}
                          placeholder="0"
                          onChange={(event) => {
                            setInputs((prev) => ({ ...prev, [row.id]: event.target.value }));
                            setHasEdits(true);
                          }}
                          disabled={pending} />
                      )}
                    </td>
                    <td className="bg-emerald-500/5 px-3 py-2 text-right">{row.withOtwDays.toFixed(2)}</td>
                    <td className="bg-slate-500/5 px-3 py-2 text-right">{row.withoutOtwDays.toFixed(2)}</td>
                    <td className="bg-lime-500/5 px-3 py-2 text-right">{row.containersToOrder.toFixed(2)}</td>
                  </tr>
                ))}
                {rows.length === 0 ? (
                  <tr><td colSpan={10} className="p-6 text-center text-muted-foreground">{tr("noSuppliers")}</td></tr>
                ) : null}
              </tbody>
              <tfoot className="sticky bottom-0 bg-muted font-bold">
                <tr>
                  <td className="px-3 py-3">{tr("planFor")}</td>
                  <td className="px-3 py-3 text-right">{displayKg(totals.inHand)}</td>
                  <td className="px-3 py-3 text-right">{displayKg(totals.otw)}</td>
                  <td className="px-3 py-3 text-right">{displayKg(totals.total)}</td>
                  <td className="bg-sky-500/10 px-3 py-3 text-right">{displayKg(totals.allocation15)}</td>
                  <td className="bg-blue-500/10 px-3 py-3 text-right">{displayKg(totals.allocation175)}</td>
                  <td className="bg-amber-500/10 px-3 py-3 text-right">{displayKg(totals.allocation20)}</td>
                  <td className="bg-emerald-500/10 px-3 py-3 text-right">{totals.withOtwDays.toFixed(2)}</td>
                  <td className="bg-slate-500/10 px-3 py-3 text-right">{totals.withoutOtwDays.toFixed(2)}</td>
                  <td className="bg-lime-500/10 px-3 py-3 text-right">{totals.containersToOrder.toFixed(2)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{tr("footerFormula")}</span>
          <span className="font-semibold">{tr("allocationTotal", { kg: displayKg(totals.allocation20) })}</span>
        </div>
      </DialogContent>
    </Dialog>
    {/* Capture outside DialogContent: its overflow-hidden/transform would clip the image. */}
    {open && <FixedProductionPlannerImage reportRef={reportRef} rows={reportRows} totals={reportTotals} dateLabel={reportDateLabel} />}
    </>
  );
}
