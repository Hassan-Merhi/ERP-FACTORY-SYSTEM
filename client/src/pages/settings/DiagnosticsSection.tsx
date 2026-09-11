import { getErrorDetails } from "@shared/errorUtils";
import { Package, AlertTriangle, ShieldCheck, Layers } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";

type OrphanedChargesDiagnostic = {
  count: number;
  impact: string | number | null;
  vouchers: { id: number; voucherNumber?: string | null }[];
} | null;

export function DiagnosticsSection({
  setOrphanedChargesDiagnostic,
  toast,
}: {
  setOrphanedChargesDiagnostic: (v: OrphanedChargesDiagnostic) => void;
  toast: ReturnType<typeof useToast>["toast"];
}) {
  const [, navigate] = useLocation();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 px-1">
        <Package className="h-5 w-5 text-muted-foreground" />
        <h3 className="font-medium text-sm uppercase tracking-wider text-muted-foreground">Diagnostics</h3>
      </div>

      <Card className="p-6">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-amber-500/10 rounded-lg">
              <AlertTriangle className="h-6 w-6 text-amber-500" />
            </div>
            <div>
              <h4 className="font-semibold" data-testid="text-diagnose-vouchers-title">
                Orphaned Vouchers
              </h4>
              <p className="text-sm text-muted-foreground">Find and clean up charge vouchers for OTW containers</p>
            </div>
          </div>
          <Button
            variant="outline"
            onClick={async () => {
              try {
                setOrphanedChargesDiagnostic(null);
                const response = await fetch("/api/debug/orphaned-charge-vouchers", {
                  method: "GET",
                  credentials: "include",
                });
                const result = await response.json();
                if (response.ok) {
                  setOrphanedChargesDiagnostic({
                    count: result.orphanedVoucherCount,
                    impact: result.totalImpact,
                    vouchers: result.orphanedVouchers || [],
                  });
                  if (result.orphanedVoucherCount === 0)
                    toast({
                      title: "No Orphaned Vouchers",
                      description: "All OTW containers have no leftover charge vouchers.",
                    });
                } else {
                  toast({ title: "Error", description: result.message, variant: "destructive" });
                }
              } catch (error) {
                toast({ title: "Error", description: getErrorDetails(error).message, variant: "destructive" });
              }
            }}
            data-testid="button-diagnose-vouchers"
          >
            Diagnose
          </Button>
        </div>
      </Card>

      <Card className="p-6">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-green-500/10 rounded-lg">
              <ShieldCheck className="h-6 w-6 text-green-600" />
            </div>
            <div>
              <h4 className="font-semibold" data-testid="text-net-position-check-title">
                Net Position Check
              </h4>
              <p className="text-sm text-muted-foreground">
                Scan account balances for discrepancies and repair ledger drift
              </p>
            </div>
          </div>
          <Button variant="outline" onClick={() => navigate("/balance-repair")} data-testid="button-net-position-check">
            Open Check
          </Button>
        </div>
      </Card>

      <Card className="p-6">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-purple-500/10 rounded-lg">
              <Layers className="h-6 w-6 text-purple-500" />
            </div>
            <div>
              <h4 className="font-semibold" data-testid="text-container-analysis-title">
                Container Analysis
              </h4>
              <p className="text-sm text-muted-foreground">Analyze offloads for duplicates and quantity issues</p>
            </div>
          </div>
          <Button variant="outline" onClick={() => navigate("/containers")} data-testid="button-container-analysis">
            View Containers
          </Button>
        </div>
      </Card>
    </div>
  );
}
