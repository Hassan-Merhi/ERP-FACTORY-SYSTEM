import { format } from "date-fns";
import { GitBranch } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { History, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";

type RevisionStatus = "pending" | "approved" | "rejected" | "cancelled" | "superseded";

/** One changed line inside a stock transfer revision. */
interface TransferRevisionItem {
  stockItemName?: string | null;
  sourceLocationName?: string | null;
  originalQuantity?: string | number | null;
  newQuantity?: string | number | null;
  delta: string | number;
}

/** A revision of a stock transfer, as returned by the revisions API. */
interface TransferRevision {
  id: number;
  revisionNumber?: number | null;
  status?: RevisionStatus;
  optional?: boolean;
  revisionDate?: string | null;
  reviewedAt?: string | null;
  note?: string | null;
  rejectionReason?: string | null;
  sourceLocationName?: string | null;
  destinationLocationName?: string | null;
  items?: TransferRevisionItem[];
}

function revisionStatus(revision: TransferRevision): RevisionStatus {
  return revision.status ?? (revision.optional ? "pending" : "approved");
}

function revisionStatusLabel(status: RevisionStatus): string {
  return status === "pending"
    ? "Pending Review"
    : status === "approved"
      ? "Approved"
      : status === "rejected"
        ? "Rejected"
        : status === "superseded"
          ? "Superseded"
          : "Cancelled";
}

function revisionStatusVariant(status: RevisionStatus): "default" | "secondary" | "destructive" | "outline" {
  if (status === "approved") return "default";
  if (status === "rejected" || status === "cancelled") return "destructive";
  if (status === "pending") return "secondary";
  return "outline";
}

interface StockTransferRevisionHistoryProps {
  voucherIdToEdit: number | null;
  stableTransferId: number | null;
  transferRevisions: TransferRevision[];
  transferRevisionsExpanded: boolean;
  setTransferRevisionsExpanded: (val: boolean | ((v: boolean) => boolean)) => void;
  setApproveRevisionTarget: (rev: TransferRevision) => void;
  modeApiRequest: unknown;
  queryClient: unknown;
  lastKnownTransferIdRef: unknown;
  formatNumber: (num: number, decimals?: number) => string;
}

export function StockTransferRevisionHistory({
  voucherIdToEdit,
  stableTransferId,
  transferRevisions,
  transferRevisionsExpanded,
  setTransferRevisionsExpanded,
  setApproveRevisionTarget,
  modeApiRequest: _modeApiRequest,
  queryClient: _queryClient,
  lastKnownTransferIdRef: _lastKnownTransferIdRef,
  formatNumber,
}: StockTransferRevisionHistoryProps) {
  if (!voucherIdToEdit || !stableTransferId) return null;

  return (
    <div className="mt-4 border rounded-xl overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center justify-between gap-2 px-4 py-3 bg-muted/40 hover:bg-muted/60 transition-colors text-left cursor-pointer select-none"
        onClick={() => setTransferRevisionsExpanded((v: boolean) => !v)}
      >
        <div className="flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Revision History</span>
          {transferRevisions.length > 0 && (
            <Badge variant="secondary" className="ml-1 text-xs no-default-active-elevate">
              {transferRevisions.length}
            </Badge>
          )}
        </div>
        {transferRevisionsExpanded ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        )}
      </button>
      {transferRevisionsExpanded && (
        <div className="p-4 space-y-4">
          {transferRevisions.length === 0 ? (
            <EmptyState
              icon={History}
              title="No revisions yet"
              description='Use "Save as Revision" to record tracked changes to this transfer.'
            />
          ) : (
            transferRevisions.map((rev) => (
              <div key={rev.id} className="border rounded-md overflow-hidden">
                {revisionStatus(rev) === "pending" && (
                  <div className="flex items-center justify-between gap-3 px-3 py-2 status-warning border-b">
                    <span className="text-xs font-medium">Pending POS adjustment — awaiting admin approval</span>
                    <Button
                      size="sm"
                      variant="default"
                      onClick={() => setApproveRevisionTarget(rev)}
                      data-testid={`button-approve-revision-${rev.id}`}
                    >
                      Approve
                    </Button>
                  </div>
                )}
                <div className="flex items-center justify-between gap-3 p-3 bg-muted/40 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant={revisionStatusVariant(revisionStatus(rev))}>Rev {rev.revisionNumber}</Badge>
                    <Badge variant={revisionStatusVariant(revisionStatus(rev))} className="text-xs">
                      {revisionStatusLabel(revisionStatus(rev))}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {rev.revisionDate ? format(new Date(rev.revisionDate), "yyyy-MM-dd") : ""}
                    </span>
                    {rev.note && <span className="text-xs italic text-muted-foreground">"{rev.note}"</span>}
                  </div>
                  <div className="text-xs text-muted-foreground text-right">
                    <div>
                      {rev.sourceLocationName || rev.items?.[0]?.sourceLocationName || "Unknown"}
                      {" → "}
                      {rev.destinationLocationName || "Unknown"}
                    </div>
                    {rev.reviewedAt && <div>Reviewed {format(new Date(rev.reviewedAt), "yyyy-MM-dd")}</div>}
                  </div>
                </div>
                {rev.rejectionReason && (
                  <div className="px-3 py-2 text-xs text-destructive border-t bg-destructive/5">
                    Reason: {rev.rejectionReason}
                  </div>
                )}
                {rev.items && rev.items.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/30">
                        <tr>
                          <th className="text-left p-2 font-medium">Item</th>
                          <th className="text-left p-2 font-medium hidden sm:table-cell">From</th>
                          <th className="text-right p-2 font-medium">Was</th>
                          <th className="text-right p-2 font-medium">Change</th>
                          <th className="text-right p-2 font-medium">Now</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rev.items
                          .filter((item) => parseFloat(String(item.delta)) !== 0)
                          .map((item, idx: number) => {
                            const delta = parseFloat(String(item.delta));
                            return (
                              <tr key={idx} className="border-t">
                                <td className="p-2 font-medium">{item.stockItemName}</td>
                                <td className="p-2 hidden sm:table-cell text-muted-foreground">
                                  {item.sourceLocationName}
                                </td>
                                <td className="p-2 text-right font-mono text-muted-foreground">
                                  {formatNumber(parseFloat(String(item.originalQuantity)), 0)}
                                </td>
                                <td
                                  className={cn(
                                    "p-2 text-right font-mono font-semibold",
                                    delta > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"
                                  )}
                                >
                                  {delta > 0 ? "+" : ""}
                                  {formatNumber(delta, 0)}
                                </td>
                                <td className="p-2 text-right font-mono font-semibold">
                                  {formatNumber(parseFloat(String(item.newQuantity)), 0)}
                                </td>
                              </tr>
                            );
                          })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
