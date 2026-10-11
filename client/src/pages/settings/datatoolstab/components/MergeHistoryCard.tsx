import { getErrorDetails } from "@shared/errorUtils";
/**
 * MergeHistoryCard — extracted sub-component.
 *
 * Extracted from DataToolsTab.tsx during the Phase 4 god-file split.
 */
import { useState } from "react";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Loader2, AlertTriangle, RotateCcw } from "lucide-react";
import type { MergeLogEntry } from "../types";

export function MergeHistoryCard({ embedded }: { embedded?: boolean }) {
  const { toast } = useToast();
  const [unmergeTarget, setUnmergeTarget] = useState<MergeLogEntry | null>(null);
  const [isUnmerging, setIsUnmerging] = useState(false);
  const [historicalRestoreTarget, setHistoricalRestoreTarget] = useState<MergeLogEntry | null>(null);
  const [isHistoricalRestoring, setIsHistoricalRestoring] = useState(false);

  const { data: logs = [], isLoading } = useQuery<MergeLogEntry[]>({
    queryKey: ["/api/stock-items/merge-logs"],
  });

  const { data: historicalLogs = [], isLoading: historicalLoading } = useQuery<MergeLogEntry[]>({
    queryKey: ["/api/stock-items/merge-logs/historical"],
  });

  const allLogs = [...logs, ...historicalLogs].sort(
    (a, b) => new Date(b.mergedAt).getTime() - new Date(a.mergedAt).getTime()
  );

  async function handleUnmerge() {
    if (!unmergeTarget) return;
    setIsUnmerging(true);
    try {
      const res = await apiRequest("POST", `/api/stock-items/merge-logs/${unmergeTarget.id}/unmerge`, {});
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Unmerge failed");
      toast({ title: "Unmerge complete", description: data.message });
      setUnmergeTarget(null);
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items/merge-logs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items/light"] });
    } catch (err) {
      toast({ title: "Unmerge failed", description: getErrorDetails(err).message, variant: "destructive" });
    } finally {
      setIsUnmerging(false);
    }
  }

  async function handleHistoricalRestore() {
    if (!historicalRestoreTarget) return;
    setIsHistoricalRestoring(true);
    try {
      const res = await apiRequest("POST", "/api/stock-items/merge-logs/historical-restore", {
        mergedItemId: historicalRestoreTarget.mergedItemId,
        keptItemId: historicalRestoreTarget.keptItemId,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Restore failed");
      toast({ title: "Item restored", description: data.message });
      setHistoricalRestoreTarget(null);
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items/merge-logs/historical"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items/light"] });
    } catch (err) {
      toast({ title: "Restore failed", description: getErrorDetails(err).message, variant: "destructive" });
    } finally {
      setIsHistoricalRestoring(false);
    }
  }

  const historyContent = (
    <>
      {isLoading || historicalLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : allLogs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No merges recorded for this company yet.</p>
      ) : (
        <>
          {historicalLogs.length > 0 && logs.length === 0 && (
            <p className="text-xs text-muted-foreground mb-3">
              These merges were done before history tracking was added. They were reconstructed from alias records — no
              snapshot is available so they cannot be unmerged automatically.
            </p>
          )}
          {historicalLogs.length > 0 && logs.length > 0 && (
            <p className="text-xs text-muted-foreground mb-3">
              Entries marked <span className="font-medium">Historical</span> were done before history tracking was added
              and cannot be unmerged automatically.
            </p>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Kept item</TableHead>
                <TableHead>Merged away</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="w-32"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {allLogs.map((log, idx) => (
                <TableRow key={log.id ?? `hist-${idx}`} data-testid={`row-merge-log-${log.id ?? idx}`}>
                  <TableCell>
                    <p className="font-medium text-sm">{log.keptItemName}</p>
                    <p className="text-xs text-muted-foreground">{log.keptItemCode}</p>
                  </TableCell>
                  <TableCell>
                    <p className="font-medium text-sm">{log.mergedItemName}</p>
                    <p className="text-xs text-muted-foreground">{log.mergedItemCode}</p>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                    {new Date(log.mergedAt).toLocaleDateString()}
                    {log.source === "historical" && (
                      <Badge variant="outline" className="ml-2 text-[11px]">
                        Historical
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {log.source === "historical" ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setHistoricalRestoreTarget(log)}
                        data-testid={`button-hist-restore-${log.mergedItemId}`}
                      >
                        <RotateCcw className="h-3 w-3 mr-1" />
                        Restore
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setUnmergeTarget(log)}
                        data-testid={`button-unmerge-${log.id}`}
                      >
                        <RotateCcw className="h-3 w-3 mr-1" />
                        Unmerge
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </>
  );

  if (embedded)
    return (
      <>
        {historyContent}
        {/* Unmerge confirmation dialog */}
        <AlertDialog
          open={!!unmergeTarget}
          onOpenChange={(open) => {
            if (!open) setUnmergeTarget(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Unmerge this item?</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-3">
                  <p>
                    This will restore <strong>{unmergeTarget?.mergedItemName}</strong> as a separate active item and
                    revert inventory quantities back to the pre-merge state.
                  </p>
                  <Alert>
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>
                      Any selling prices that were deleted during the merge (because the kept item already had a price
                      for that location) cannot be recovered automatically. You may need to re-enter them manually.
                    </AlertDescription>
                  </Alert>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isUnmerging} data-testid="button-unmerge-cancel">
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction onClick={handleUnmerge} disabled={isUnmerging} data-testid="button-unmerge-confirm">
                {isUnmerging ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Unmerging…
                  </>
                ) : (
                  "Yes, unmerge it"
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Historical restore confirmation dialog */}
        <AlertDialog
          open={!!historicalRestoreTarget}
          onOpenChange={(open) => {
            if (!open) setHistoricalRestoreTarget(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Restore this item?</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-3">
                  <p>
                    This will restore <strong>{historicalRestoreTarget?.mergedItemName}</strong> (
                    {historicalRestoreTarget?.mergedItemCode}) as a separate active item.
                  </p>
                  <p className="text-sm">
                    The item will reappear in your stock list with its original name and code. Its code alias (which was
                    redirecting scans to <strong>{historicalRestoreTarget?.keptItemName}</strong>) will be removed.
                  </p>
                  <Alert>
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>
                      Because this merge happened before history tracking was added, inventory quantities{" "}
                      <strong>cannot be restored automatically</strong>. The item will come back with zero stock. You
                      will need to manually adjust quantities between{" "}
                      <strong>{historicalRestoreTarget?.mergedItemName}</strong> and{" "}
                      <strong>{historicalRestoreTarget?.keptItemName}</strong>.
                    </AlertDescription>
                  </Alert>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isHistoricalRestoring} data-testid="button-hist-restore-cancel">
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={handleHistoricalRestore}
                disabled={isHistoricalRestoring}
                data-testid="button-hist-restore-confirm"
              >
                {isHistoricalRestoring ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Restoring…
                  </>
                ) : (
                  "Yes, restore it"
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <RotateCcw className="h-4 w-4" />
          Merge History
        </CardTitle>
        <CardDescription>
          View recent item merges and reverse them if needed. Inventory quantities and values are restored exactly from
          the pre-merge snapshot. Location prices deleted during merge cannot be recovered.
        </CardDescription>
      </CardHeader>
      <CardContent>{historyContent}</CardContent>

      {/* Unmerge confirmation dialog */}
      <AlertDialog
        open={!!unmergeTarget}
        onOpenChange={(open) => {
          if (!open) setUnmergeTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unmerge this item?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  This will restore <strong>{unmergeTarget?.mergedItemName}</strong> as a separate active item and
                  revert inventory quantities back to the pre-merge state.
                </p>
                <Alert>
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    Any selling prices that were deleted during the merge (because the kept item already had a price for
                    that location) cannot be recovered automatically. You may need to re-enter them manually.
                  </AlertDescription>
                </Alert>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isUnmerging} data-testid="button-unmerge-cancel">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleUnmerge} disabled={isUnmerging} data-testid="button-unmerge-confirm">
              {isUnmerging ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Unmerging…
                </>
              ) : (
                "Yes, unmerge it"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Historical restore confirmation dialog */}
      <AlertDialog
        open={!!historicalRestoreTarget}
        onOpenChange={(open) => {
          if (!open) setHistoricalRestoreTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore this item?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  This will restore <strong>{historicalRestoreTarget?.mergedItemName}</strong> (
                  {historicalRestoreTarget?.mergedItemCode}) as a separate active item.
                </p>
                <p className="text-sm">
                  The item will reappear in your stock list with its original name and code. Its code alias (which was
                  redirecting scans to <strong>{historicalRestoreTarget?.keptItemName}</strong>) will be removed.
                </p>
                <Alert>
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    Because this merge happened before history tracking was added, inventory quantities{" "}
                    <strong>cannot be restored automatically</strong>. The item will come back with zero stock. You will
                    need to manually adjust quantities between{" "}
                    <strong>{historicalRestoreTarget?.mergedItemName}</strong> and{" "}
                    <strong>{historicalRestoreTarget?.keptItemName}</strong>.
                  </AlertDescription>
                </Alert>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isHistoricalRestoring} data-testid="button-hist-restore-cancel">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleHistoricalRestore}
              disabled={isHistoricalRestoring}
              data-testid="button-hist-restore-confirm"
            >
              {isHistoricalRestoring ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Restoring…
                </>
              ) : (
                "Yes, restore it"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

// ── Reconcile OTW Names Card ──────────────────────────────────────────────────
