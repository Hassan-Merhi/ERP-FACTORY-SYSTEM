import type { ClientErrorLike } from "@/lib/clientError";
/**
 * ProfitOpeningRunner — extracted sub-component.
 *
 * Extracted from GcLshiMigration.tsx during the Phase 4 god-file split.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DollarSign } from "lucide-react";

import { fmtNum } from "../utils";

export function ProfitOpeningRunner({ targetCompanyId, onDone }: { targetCompanyId: number; onDone: () => void }) {
  const { toast } = useToast();
  const [cutoffDate, setCutoffDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [accumulatedProfit, setAccumulatedProfit] = useState("");
  const [ourSplitPct, setOurSplitPct] = useState("50");
  const [useManualSplit, setUseManualSplit] = useState(false);
  const [ourShareAmount, setOurShareAmount] = useState("");
  const [supplierShareAmount, setSupplierShareAmount] = useState("");
  const [result, setResult] = useState<{
    voucherNumber?: string;
    ourShare?: number | string;
    supplierShare?: number | string;
  } | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/sp/migration/gc-profit-opening", {
        targetCompanyId,
        cutoffDate,
        accumulatedProfit,
        ...(useManualSplit ? { ourShareAmount, supplierShareAmount } : { ourSplitPct }),
      }),
    onSuccess: async (data) => {
      const r = await data.json();
      setResult(r);
      toast({ title: "Profit-share opening balance posted", description: `Voucher ${r.voucherNumber}` });
      onDone();
    },
    onError: (e: ClientErrorLike) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium">
        <DollarSign className="h-4 w-4 text-muted-foreground" />
        Profit-Share Opening Balance
      </div>
      <p className="text-xs text-muted-foreground">
        Posts a balanced journal: Dr Accumulated Profit Clearing → Cr Our Share + Cr Supplier Share.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
        <div className="space-y-1">
          <Label>Cutoff Date</Label>
          <Input type="date" value={cutoffDate} onChange={(e) => setCutoffDate(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>Accumulated Profit (USD)</Label>
          <Input
            type="number"
            min="0"
            step="0.01"
            value={accumulatedProfit}
            onChange={(e) => setAccumulatedProfit(e.target.value)}
            placeholder="0.00"
          />
        </div>
        {!useManualSplit && (
          <div className="space-y-1">
            <Label>Our Split %</Label>
            <Input
              type="number"
              min="0"
              max="100"
              step="1"
              value={ourSplitPct}
              onChange={(e) => setOurSplitPct(e.target.value)}
            />
          </div>
        )}
      </div>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input type="checkbox" checked={useManualSplit} onChange={(e) => setUseManualSplit(e.target.checked)} />
        Use manual split amounts instead of a percentage
      </label>
      {useManualSplit && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
          <div className="space-y-1">
            <Label>Our Share Amount (USD)</Label>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={ourShareAmount}
              onChange={(e) => setOurShareAmount(e.target.value)}
              placeholder="0.00"
            />
          </div>
          <div className="space-y-1">
            <Label>Supplier Share Amount (USD)</Label>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={supplierShareAmount}
              onChange={(e) => setSupplierShareAmount(e.target.value)}
              placeholder="0.00"
            />
          </div>
        </div>
      )}
      <Button
        size="sm"
        onClick={() => mutation.mutate()}
        disabled={
          !cutoffDate ||
          !accumulatedProfit ||
          mutation.isPending ||
          (useManualSplit && (!ourShareAmount || !supplierShareAmount))
        }
        data-testid="button-run-profit-opening"
      >
        {mutation.isPending ? "Posting…" : "Post Opening Balance"}
      </Button>
      {result && (
        <p className="text-xs text-muted-foreground">
          Our share: ${fmtNum(result.ourShare)} · Supplier share: ${fmtNum(result.supplierShare)} (voucher{" "}
          {result.voucherNumber})
        </p>
      )}
    </div>
  );
}

// ── Final reconciliation report ─────────────────────────────────────────────
