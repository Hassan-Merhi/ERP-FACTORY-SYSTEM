import { getErrorDetails } from "@shared/errorUtils";
import { useState } from "react";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { PageHeader } from "@/components/PageHeader";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { Loader2, AlertTriangle, CheckCircle, Search, Wrench, ShieldAlert } from "lucide-react";

interface Discrepancy {
  locationId: number;
  stockItemId: number;
  locationName: string;
  stockItemName: string;
  stockItemCode: string;
  currentQty: number;
  expectedQty: number;
  difference: number;
  currentValue: number;
  expectedValue: number;
}

interface RebuildResult {
  success: boolean;
  dryRun: boolean;
  staleFlagsFound: number;
  staleFlagsFixed: number;
  totalInventoryRecords: number;
  discrepanciesFound: number;
  fixesApplied: number;
  discrepancies: Discrepancy[];
  warnings: string[];
}

interface ValueRepairRow {
  id: number;
  locationId: number;
  locationName: string;
  stockItemId: number;
  stockItemName: string;
  quantity: number;
  oldRate: number;
  oldValue: number;
  newRate: number;
  newValue: number;
  reason: string;
}

export default function InventoryRepair() {
  const { toast } = useToast();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const [result, setResult] = useState<RebuildResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"idle" | "preview" | "applied">("idle");

  const [valueRepairRows, setValueRepairRows] = useState<ValueRepairRow[]>([]);
  const [valueRepairState, setValueRepairState] = useState<"idle" | "previewing" | "previewed" | "finalizing">("idle");

  async function runRebuild(dryRun: boolean) {
    setLoading(true);
    try {
      const res = await modeApiRequest("POST", "/api/admin/rebuild-inventory", { dryRun });
      const data: RebuildResult = await res.json();
      setResult(data);
      setMode(dryRun ? "preview" : "applied");
      toast({
        title: dryRun ? "Preview Complete" : "Fixes Applied",
        description: dryRun
          ? `Found ${data.discrepanciesFound} discrepancies across ${data.totalInventoryRecords} inventory records.`
          : `Applied ${data.fixesApplied} fixes. Inventory has been corrected.`,
      });
    } catch (error) {
      toast({
        title: "Error",
        description: getErrorDetails(error).message || "Failed to run inventory rebuild",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }

  async function previewValueRepair() {
    setValueRepairState("previewing");
    try {
      const res = await modeApiRequest("GET", "/api/admin/repair-inventory-values/preview");
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Preview failed");
      }
      const data = await res.json();
      setValueRepairRows(data.rows || []);
      setValueRepairState("previewed");
      toast({
        title: "Preview Complete",
        description:
          data.rows.length > 0
            ? `Found ${data.rows.length} corrupted inventory value row(s).`
            : "No corrupted inventory rows found.",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: getErrorDetails(error).message || "Failed to preview value repair",
        variant: "destructive",
      });
      setValueRepairState("idle");
    }
  }

  async function finalizeValueRepair() {
    setValueRepairState("finalizing");
    try {
      const res = await modeApiRequest("POST", "/api/admin/repair-inventory-values", {});
      const data = await res.json();
      toast({
        title: "Repair Complete",
        description: data.message || `Repaired ${data.corrected} rows.`,
      });
      setValueRepairRows([]);
      setValueRepairState("idle");
    } catch (error) {
      toast({
        title: "Error",
        description: getErrorDetails(error).message || "Failed to finalize value repair",
        variant: "destructive",
      });
      setValueRepairState("previewed");
    }
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6 sm:p-4 md:p-6">
      <PageHeader
        title="Inventory Repair Tool"
        subtitle="Recalculates expected inventory by replaying all voucher-backed operations and compares with current stock levels."
      />

      <Alert>
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription>
          Quick adjustments (manual add/subtract) are not backed by vouchers and cannot be replayed. If you have used
          quick adjustments, those quantities may appear as discrepancies — review carefully before applying fixes.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle>Run Inventory Audit</CardTitle>
          <CardDescription>
            Preview discrepancies first, then apply fixes if needed. The tool also detects and corrects stale transfer
            flags that could cause future issues.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Button
            onClick={() => runRebuild(true)}
            disabled={loading}
            variant="outline"
            data-testid="button-preview-discrepancies"
          >
            {loading && mode !== "applied" ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Search className="mr-2 h-4 w-4" />
            )}
            Preview Discrepancies
          </Button>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                disabled={loading || !result || result.discrepanciesFound === 0}
                variant="default"
                data-testid="button-apply-fixes"
              >
                <Wrench className="mr-2 h-4 w-4" />
                Apply Fixes
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Confirm Inventory Fix</AlertDialogTitle>
                <AlertDialogDescription>
                  This will update {result?.discrepanciesFound || 0} inventory records to match the expected quantities
                  calculated from all voucher-backed operations. This action cannot be automatically undone.
                  {result && result.staleFlagsFound > 0 && (
                    <span className="block mt-2 font-medium">
                      Additionally, {result.staleFlagsFound} stale transfer flags will be corrected to prevent future
                      issues.
                    </span>
                  )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel data-testid="button-cancel-fix">Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => runRebuild(false)} data-testid="button-confirm-fix">
                  Yes, Apply Fixes
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardContent>
      </Card>

      {result && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Summary</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <p className="text-sm text-muted-foreground" data-testid="text-label-total-records">
                    Total Records Checked
                  </p>
                  <p className="text-2xl font-bold" data-testid="text-total-records">
                    {result.totalInventoryRecords}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground" data-testid="text-label-discrepancies">
                    Discrepancies Found
                  </p>
                  <p className="text-2xl font-bold" data-testid="text-discrepancies-count">
                    {result.discrepanciesFound}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground" data-testid="text-label-stale-flags">
                    Stale Transfer Flags
                  </p>
                  <p className="text-2xl font-bold" data-testid="text-stale-flags">
                    {result.staleFlagsFound}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground" data-testid="text-label-fixes">
                    Fixes Applied
                  </p>
                  <p className="text-2xl font-bold" data-testid="text-fixes-applied">
                    {result.fixesApplied}
                  </p>
                </div>
              </div>

              {mode === "applied" && result.fixesApplied > 0 && (
                <Alert className="mt-4">
                  <CheckCircle className="h-4 w-4" />
                  <AlertDescription>
                    Successfully applied {result.fixesApplied} inventory corrections and fixed {result.staleFlagsFixed}{" "}
                    stale transfer flags.
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>

          {result.discrepancies.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>
                  {mode === "applied" ? "Corrections Made" : "Discrepancies"}
                  <Badge variant="secondary" className="ml-2">
                    {result.discrepancies.length}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-auto">
                  <Table>
                    <TableHeader className="sticky top-0 z-30 bg-background">
                      <TableRow>
                        <TableHead>Location</TableHead>
                        <TableHead>Stock Item</TableHead>
                        <TableHead>Code</TableHead>
                        <TableHead className="text-right">Current Qty</TableHead>
                        <TableHead className="text-right">Expected Qty</TableHead>
                        <TableHead className="text-right">Qty Diff</TableHead>
                        <TableHead className="text-right">Current Value</TableHead>
                        <TableHead className="text-right">Expected Value</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.discrepancies.map((d, i) => (
                        <TableRow key={`${d.locationId}-${d.stockItemId}`} data-testid={`row-discrepancy-${i}`}>
                          <TableCell data-testid={`text-location-${i}`}>{d.locationName}</TableCell>
                          <TableCell data-testid={`text-item-${i}`}>{d.stockItemName}</TableCell>
                          <TableCell data-testid={`text-code-${i}`}>{d.stockItemCode}</TableCell>
                          <TableCell className="text-right" data-testid={`text-current-qty-${i}`}>
                            {d.currentQty.toFixed(3)}
                          </TableCell>
                          <TableCell className="text-right" data-testid={`text-expected-qty-${i}`}>
                            {d.expectedQty.toFixed(3)}
                          </TableCell>
                          <TableCell className="text-right" data-testid={`text-difference-${i}`}>
                            <span
                              className={
                                d.difference > 0
                                  ? "text-green-600 dark:text-green-400"
                                  : "text-red-600 dark:text-red-400"
                              }
                            >
                              {d.difference > 0 ? "+" : ""}
                              {d.difference.toFixed(3)}
                            </span>
                          </TableCell>
                          <TableCell className="text-right" data-testid={`text-current-value-${i}`}>
                            {d.currentValue.toFixed(2)}
                          </TableCell>
                          <TableCell className="text-right" data-testid={`text-expected-value-${i}`}>
                            {d.expectedValue.toFixed(2)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          )}

          {result.discrepancies.length === 0 && (
            <Card>
              <CardContent className="py-8 text-center">
                <CheckCircle className="mx-auto h-12 w-12 text-green-500 mb-3" />
                <p className="text-lg font-medium" data-testid="text-no-discrepancies">
                  No discrepancies found
                </p>
                <p className="text-muted-foreground mt-1">
                  Inventory quantities match expected values from all voucher-backed operations.
                </p>
              </CardContent>
            </Card>
          )}
        </>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 flex-wrap">
            <ShieldAlert className="h-5 w-5" />
            Inventory Value Repair
          </CardTitle>
          <CardDescription>
            Detects inventory rows with corrupted valuation (negative rates, value on zero-quantity rows, etc.) and lets
            you repair them safely.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Button
            onClick={previewValueRepair}
            disabled={valueRepairState === "previewing" || valueRepairState === "finalizing"}
            variant="outline"
            data-testid="button-preview-value-repair"
          >
            {valueRepairState === "previewing" ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Search className="mr-2 h-4 w-4" />
            )}
            Preview Inventory Value Repair
          </Button>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                disabled={valueRepairState !== "previewed" || valueRepairRows.length === 0}
                variant="default"
                data-testid="button-finalize-value-repair"
              >
                {valueRepairState === "finalizing" ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Wrench className="mr-2 h-4 w-4" />
                )}
                Finalize Repair
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Confirm Value Repair</AlertDialogTitle>
                <AlertDialogDescription>
                  This will update {valueRepairRows.length} inventory row(s) to correct their average rate and total
                  value. Quantities will not be changed. This action cannot be automatically undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel data-testid="button-cancel-value-repair">Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={finalizeValueRepair} data-testid="button-confirm-value-repair">
                  Yes, Finalize Repair
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardContent>
      </Card>

      {valueRepairState === "previewed" && valueRepairRows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>
              Corrupted Value Rows
              <Badge variant="secondary" className="ml-2">
                {valueRepairRows.length}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Alert className="mb-4">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                The following rows have invalid valuation and will be corrected if you finalize. Quantities will remain
                unchanged — only rate and value will be updated.
              </AlertDescription>
            </Alert>
            <div className="overflow-auto">
              <Table>
                <TableHeader className="sticky top-0 z-30 bg-background">
                  <TableRow>
                    <TableHead>Location</TableHead>
                    <TableHead>Item</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Old Rate</TableHead>
                    <TableHead className="text-right">Old Value</TableHead>
                    <TableHead className="text-right">New Rate</TableHead>
                    <TableHead className="text-right">New Value</TableHead>
                    <TableHead>Reason</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {valueRepairRows.map((r, i) => (
                    <TableRow key={r.id} data-testid={`row-value-repair-${i}`}>
                      <TableCell data-testid={`text-vr-location-${i}`}>{r.locationName}</TableCell>
                      <TableCell data-testid={`text-vr-item-${i}`}>{r.stockItemName}</TableCell>
                      <TableCell className="text-right" data-testid={`text-vr-qty-${i}`}>
                        {r.quantity.toFixed(3)}
                      </TableCell>
                      <TableCell className="text-right" data-testid={`text-vr-old-rate-${i}`}>
                        {r.oldRate.toFixed(2)}
                      </TableCell>
                      <TableCell className="text-right" data-testid={`text-vr-old-value-${i}`}>
                        {r.oldValue.toFixed(2)}
                      </TableCell>
                      <TableCell
                        className="text-right text-green-600 dark:text-green-400"
                        data-testid={`text-vr-new-rate-${i}`}
                      >
                        {r.newRate.toFixed(2)}
                      </TableCell>
                      <TableCell
                        className="text-right text-green-600 dark:text-green-400"
                        data-testid={`text-vr-new-value-${i}`}
                      >
                        {r.newValue.toFixed(2)}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground" data-testid={`text-vr-reason-${i}`}>
                        {r.reason}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {valueRepairState === "previewed" && valueRepairRows.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center">
            <CheckCircle className="mx-auto h-12 w-12 text-green-500 mb-3" />
            <p className="text-lg font-medium" data-testid="text-no-corrupted-rows">
              No corrupted inventory rows found
            </p>
            <p className="text-muted-foreground mt-1">All inventory value and rate fields are within valid ranges.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
