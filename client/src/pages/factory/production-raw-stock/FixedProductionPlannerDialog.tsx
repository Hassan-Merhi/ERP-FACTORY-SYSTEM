import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Calculator, Lock, LockOpen, RefreshCw, Save } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { formatNumber } from "@/lib/formatNumber";
import { getApiRequest } from "@/lib/factoryApi";
import { queryClient } from "@/lib/queryClient";
import type { RawStockRow } from "./RawStockTable";
import type { OffloadSupplierOption } from "./offloadDialogTypes";

interface FixedProductionPlannerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rawStock: RawStockRow[];
  suppliers: OffloadSupplierOption[];
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
const EXPECTED_TARGET_KG = 20000;
const apiRequest = getApiRequest("factory");

function asKg(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function displayKg(value: number): string {
  return formatNumber(value, 3);
}

export function FixedProductionPlannerDialog({
  open, onOpenChange, rawStock, suppliers,
}: FixedProductionPlannerDialogProps) {
  const { toast } = useToast();
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [hasEdits, setHasEdits] = useState(false);

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
      toast({ title: "Production plan saved and locked", description: "Unlock the plan before editing the 20-ton allocation again." });
    },
    onError: (err: Error) => toast({ title: "Could not save plan", description: err.message, variant: "destructive" }),
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
      toast({ title: "Production plan unlocked", description: "You may now edit the 20-ton allocations. Save to lock the plan again." });
    },
    onError: (err: Error) => toast({ title: "Could not unlock plan", description: err.message, variant: "destructive" }),
  });

  const stockBySupplier = useMemo(() => {
    const amounts = new Map<number, number>();
    for (const row of rawStock) {
      if (row.supplierId == null) continue;
      amounts.set(row.supplierId, (amounts.get(row.supplierId) ?? 0) + asKg(row.freeKg ?? row.remainingKg));
    }
    return amounts;
  }, [rawStock]);

  const otwBySupplier = useMemo(() => {
    const amounts = new Map<number, number>();
    // Match Factory Containers' OTW Summary status and total-weight rules exactly.
    const statuses = new Set(["PENDING", "IN_TRANSIT", "ARRIVED"]);
    for (const container of otwQuery.data ?? []) {
      if (container.supplierId == null || !statuses.has(container.status)) continue;
      amounts.set(container.supplierId,
        (amounts.get(container.supplierId) ?? 0) + asKg(container.totalKg));
    }
    return amounts;
  }, [otwQuery.data]);

  const rows = useMemo(() => {
    return [...suppliers].sort((a, b) => a.name.localeCompare(b.name)).map((supplier) => {
      const id = String(supplier.id);
      const inHand = stockBySupplier.get(supplier.id) ?? 0;
      const otw = otwBySupplier.get(supplier.id) ?? 0;
      const allocation20 = asKg(inputs[id]);
      return {
        id, name: supplier.name, inHand, otw, total: inHand + otw,
        allocation20, allocation15: allocation20 * 15 / 20,
        allocation175: allocation20 * 17.5 / 20,
      };
    });
  }, [suppliers, stockBySupplier, otwBySupplier, inputs]);

  const totals = useMemo(() => rows.reduce((acc, row) => {
    acc.inHand += row.inHand;
    acc.otw += row.otw;
    acc.total += row.total;
    acc.allocation15 += row.allocation15;
    acc.allocation175 += row.allocation175;
    acc.allocation20 += row.allocation20;
    return acc;
  }, { inHand: 0, otw: 0, total: 0, allocation15: 0, allocation175: 0, allocation20: 0 }), [rows]);

  const locked = planQuery.data?.locked ?? false;
  const ready = !!planQuery.data && !!otwQuery.data && !planQuery.isFetching && !otwQuery.isFetching;
  const pending = saveMutation.isPending || unlockMutation.isPending;

  const saveAndLock = () => {
    if (locked || pending) return;
    const allocations: Record<string, number> = {};
    for (const row of rows) {
      const raw = inputs[row.id]?.trim() ?? "";
      const quantity = raw === "" ? 0 : Number(raw);
      if (!Number.isFinite(quantity) || quantity < 0 || quantity > EXPECTED_TARGET_KG ||
          !/^\d+(?:\.\d{1,3})?$/.test(raw || "0")) {
        toast({
          title: "Invalid 20-ton quantity",
          description: `Enter a nonnegative kg value (up to three decimals) for ${row.name}.`,
          variant: "destructive",
        });
        return;
      }
      allocations[row.id] = quantity;
    }
    saveMutation.mutate(allocations);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next); }}>
      <DialogContent className="flex max-h-[92vh] w-[97vw] max-w-6xl flex-col gap-3 overflow-hidden p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <Calculator className="h-5 w-5 text-amber-500" /> Fixed Production Planner
          </DialogTitle>
          <DialogDescription>
            In Hand comes from Raw Materials; OTW is the live Pending / In Transit / Arrived stock from Factory Containers.
            Edit only the 20-ton column. The 15-ton and 17.5-ton quantities are calculated automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {locked ? <Lock className="h-4 w-4 text-amber-500" /> : <LockOpen className="h-4 w-4 text-emerald-500" />}
            <span className="font-semibold">{locked ? "Saved and locked" : "Unlocked for editing"}</span>
            {planQuery.data?.updatedAt && (
              <span className="text-muted-foreground">Last saved: {new Date(planQuery.data.updatedAt).toLocaleString()}</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => {
              setHasEdits(false);
              void Promise.all([planQuery.refetch(), otwQuery.refetch()]);
            }} disabled={pending} className="gap-1.5">
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
            {locked ? (
              <Button size="sm" variant="outline" className="gap-1.5" disabled={!ready || pending}
                onClick={() => unlockMutation.mutate()}>
                <LockOpen className="h-3.5 w-3.5" /> {unlockMutation.isPending ? "Unlocking..." : "Unlock to Edit"}
              </Button>
            ) : (
              <Button size="sm" className="gap-1.5" disabled={!ready || pending}
                onClick={saveAndLock}>
                <Save className="h-3.5 w-3.5" /> {saveMutation.isPending ? "Saving..." : "Save & Lock"}
              </Button>
            )}
          </div>
        </div>

        {planQuery.isError || otwQuery.isError ? (
          <div role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">
            Unable to load the saved plan or incoming containers. Use Refresh to retry.
          </div>
        ) : null}
        {!ready && !planQuery.isError && !otwQuery.isError ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading live supplier stock and plan...</p>
        ) : (
          <div className="min-h-0 overflow-auto rounded-lg border">
            <table className="w-full min-w-[940px] border-collapse text-sm tabular-nums">
              <thead className="sticky top-0 z-10 bg-muted text-xs uppercase">
                <tr>
                  <th className="border-b p-3 text-left">Origin / Supplier</th>
                  <th className="border-b p-3 text-right">In Hand (kg)</th>
                  <th className="border-b p-3 text-right">OTW (kg)</th>
                  <th className="border-b p-3 text-right">Total (kg)</th>
                  <th className="border-b bg-sky-500/10 p-3 text-right">15 Tons (kg)</th>
                  <th className="border-b bg-blue-500/10 p-3 text-right">17.5 Tons (kg)</th>
                  <th className="border-b bg-amber-500/10 p-3 text-right">20 Tons (kg)</th>
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
                        <Input type="number" inputMode="decimal" min="0" max="20000" step="0.001"
                          aria-label={`20-ton allocation for ${row.name}`}
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
                  </tr>
                ))}
                {rows.length === 0 ? (
                  <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">No suppliers found for this company.</td></tr>
                ) : null}
              </tbody>
              <tfoot className="sticky bottom-0 bg-muted font-bold">
                <tr>
                  <td className="px-3 py-3">PLAN FOR</td>
                  <td className="px-3 py-3 text-right">{displayKg(totals.inHand)}</td>
                  <td className="px-3 py-3 text-right">{displayKg(totals.otw)}</td>
                  <td className="px-3 py-3 text-right">{displayKg(totals.total)}</td>
                  <td className="bg-sky-500/10 px-3 py-3 text-right">{displayKg(totals.allocation15)}</td>
                  <td className="bg-blue-500/10 px-3 py-3 text-right">{displayKg(totals.allocation175)}</td>
                  <td className="bg-amber-500/10 px-3 py-3 text-right">{displayKg(totals.allocation20)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>15 Tons = 20 Tons × 0.75. 17.5 Tons = 20 Tons × 0.875. Stock numbers update from live data.</span>
          <span className={Math.abs(totals.allocation20 - EXPECTED_TARGET_KG) < 0.001
            ? "font-semibold text-emerald-600" : "font-semibold text-amber-600"}>
            20t allocation: {displayKg(totals.allocation20)} / 20,000 kg
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
