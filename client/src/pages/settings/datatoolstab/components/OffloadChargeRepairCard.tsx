import { getErrorDetails } from "@shared/errorUtils";
/**
 * OffloadChargeRepairCard — re-price offloads whose duty / transport / office /
 * transfer voucher was edited before voucher edits updated the bales.
 *
 * Preview lists every container whose stored charge differs from its live
 * vouchers; Apply carries the difference into the offload, its lines and the
 * inventory still on hand.
 */
import { useState } from "react";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, invalidateContainerLandedCostQueries } from "@/lib/queryClient";
import { Loader2, Wrench } from "lucide-react";

interface ChargeDrift {
  offloadId: number;
  containerNumber: string;
  locationName: string | null;
  offloadedAt: string;
  prefix: "DUTY" | "OFFICE" | "TRANS" | "XFER";
  stored: string;
  vouchers: string;
  chargeDelta: string;
  oldCostPerBale: string;
  newCostPerBale: string;
  balesOnHand: string;
}

const CHARGE_LABEL: Record<ChargeDrift["prefix"], string> = {
  DUTY: "Duties",
  OFFICE: "Office",
  TRANS: "Transport",
  XFER: "Transfer",
};

const ENDPOINT = "/api/admin/offload-charge-voucher-repair";

export function OffloadChargeRepairCard() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [drift, setDrift] = useState<ChargeDrift[] | null>(null);
  const [repairedCount, setRepairedCount] = useState<number | null>(null);

  async function handlePreview() {
    setLoading(true);
    setRepairedCount(null);
    try {
      const res = await apiRequest("GET", ENDPOINT);
      const data = await res.json();
      setDrift(data.drift ?? []);
    } catch (err) {
      toast({ title: "Preview failed", description: getErrorDetails(err).message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  async function handleApply() {
    if (!drift || drift.length === 0) return;
    const containers = new Set(drift.map((row) => row.offloadId)).size;
    if (!window.confirm(`Re-price ${containers} container(s) to match their vouchers? This updates inventory costs.`)) {
      return;
    }
    setApplying(true);
    try {
      const res = await apiRequest("POST", ENDPOINT, { offloadIds: drift.map((row) => row.offloadId) });
      const data = await res.json();
      setRepairedCount(data.repaired?.length ?? 0);
      setDrift(null);
      invalidateContainerLandedCostQueries();
      toast({ title: `Updated ${data.repaired?.length ?? 0} charge(s)` });
    } catch (err) {
      toast({ title: "Repair failed", description: getErrorDetails(err).message, variant: "destructive" });
    } finally {
      setApplying(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Wrench className="h-4 w-4" />
          Fix Offload Charge Costs
        </CardTitle>
        <CardDescription className="text-xs">
          Finds offloaded containers whose duty, transport, office or transfer voucher was edited without the cost per
          bale updating, and re-prices the offload and the bales still in stock. Bales already sold keep their cost.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {repairedCount !== null && (
          <Alert>
            <AlertDescription className="text-sm">Updated {repairedCount} charge(s).</AlertDescription>
          </Alert>
        )}
        {drift && drift.length === 0 && (
          <Alert>
            <AlertDescription className="text-sm">Every offload already matches its vouchers.</AlertDescription>
          </Alert>
        )}
        {drift && drift.length > 0 && (
          <div className="max-h-80 overflow-auto rounded-md border">
            <table className="w-full text-xs tabular-nums">
              <thead className="sticky top-0 bg-muted text-left">
                <tr>
                  <th className="p-2">Container</th>
                  <th className="p-2">Charge</th>
                  <th className="p-2 text-right">Offload</th>
                  <th className="p-2 text-right">Voucher</th>
                  <th className="p-2 text-right">Per bale</th>
                  <th className="p-2 text-right">In stock</th>
                </tr>
              </thead>
              <tbody>
                {drift.map((row) => (
                  <tr key={`${row.offloadId}-${row.prefix}`} className="border-t">
                    <td className="p-2">
                      <div className="font-medium">{row.containerNumber}</div>
                      <div className="text-muted-foreground">
                        {row.locationName ?? "—"} · {row.offloadedAt}
                      </div>
                    </td>
                    <td className="p-2">{CHARGE_LABEL[row.prefix]}</td>
                    <td className="p-2 text-right">{row.stored}</td>
                    <td className="p-2 text-right">{row.vouchers}</td>
                    <td className="p-2 text-right whitespace-nowrap">
                      {row.oldCostPerBale} → {row.newCostPerBale}
                    </td>
                    <td className="p-2 text-right">{Number(row.balesOnHand)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex gap-2">
          <Button
            variant="outline"
            className="flex-1"
            onClick={handlePreview}
            disabled={loading || applying}
            data-testid="button-preview-offload-charge-repair"
          >
            {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Preview
          </Button>
          <Button
            className="flex-1"
            onClick={handleApply}
            disabled={applying || !drift || drift.length === 0}
            data-testid="button-apply-offload-charge-repair"
          >
            {applying && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Apply
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
