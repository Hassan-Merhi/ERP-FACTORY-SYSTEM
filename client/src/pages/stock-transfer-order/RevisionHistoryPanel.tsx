import type { Dispatch, SetStateAction } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { ChevronDown, ChevronUp, GitBranch, Trash2 } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatNumber } from "@/lib/formatNumber";
import type { StockTransferRevision } from "../stocktransferorder/types";
import { confirmAction } from "@/components/ConfirmHost";

type RevisionHistoryPanelProps = {
  editVoucherId: number | null;
  transferId: number | undefined;
  revisions: StockTransferRevision[];
  revisionsExpanded: boolean;
  setRevisionsExpanded: Dispatch<SetStateAction<boolean>>;
};

export function RevisionHistoryPanel({
  editVoucherId,
  transferId,
  revisions,
  revisionsExpanded,
  setRevisionsExpanded,
}: RevisionHistoryPanelProps) {
  if (!editVoucherId || !transferId) return null;

  return (
    <Card>
      <CardHeader
        className="p-4 sm:p-5 cursor-pointer select-none"
        onClick={() => setRevisionsExpanded((value) => !value)}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">Revision History</CardTitle>
            {revisions.length > 0 && (
              <Badge variant="secondary" className="ml-1">
                {revisions.length}
              </Badge>
            )}
          </div>
          {revisionsExpanded ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </CardHeader>

      {revisionsExpanded && (
        <CardContent className="pt-0 space-y-4">
          {revisions.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              No revisions yet. Use "Save as Revision" to record tracked changes.
            </p>
          ) : (
            revisions.map((revision) => (
              <div key={revision.id} className="border rounded-md overflow-hidden">
                <div className="flex items-center justify-between gap-3 p-3 bg-muted/40 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant={revision.optional ? "secondary" : "default"}>Rev {revision.revisionNumber}</Badge>
                    {revision.optional && (
                      <Badge variant="outline" className="text-xs">
                        Reference Only
                      </Badge>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {revision.revisionDate ? new Date(revision.revisionDate).toLocaleDateString() : ""}
                    </span>
                    {revision.note && <span className="text-xs italic text-muted-foreground">"{revision.note}"</span>}
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-muted-foreground">Reference only:</span>
                      <Switch
                        checked={revision.optional}
                        onCheckedChange={async (checked) => {
                          try {
                            await apiRequest("PATCH", `/api/stock-transfer-revisions/${revision.id}/optional`, {
                              optional: checked,
                            });
                          } finally {
                            queryClient.invalidateQueries({
                              queryKey: ["/api/stock-transfers", transferId, "revisions"],
                            });
                          }
                        }}
                        data-testid={`switch-revision-optional-${revision.id}`}
                      />
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={async () => {
                        if (
                          !(await confirmAction({
                            title: `Delete Rev ${revision.revisionNumber}? This cannot be undone.`,
                            tone: "destructive",
                          }))
                        )
                          return;
                        await apiRequest("DELETE", `/api/stock-transfer-revisions/${revision.id}`);
                        queryClient.invalidateQueries({
                          queryKey: ["/api/stock-transfers", transferId, "revisions"],
                        });
                      }}
                      data-testid={`button-delete-revision-${revision.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                {revision.items && revision.items.length > 0 && (
                  <div className="table-responsive">
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
                        {revision.items.map((item, index) => {
                          const delta = parseFloat(String(item.delta));
                          return (
                            <tr key={index} className="border-t">
                              <td className="p-2 font-medium">{item.stockItemName}</td>
                              <td className="p-2 text-muted-foreground hidden sm:table-cell">
                                {item.sourceLocationName || "—"}
                              </td>
                              <td className="p-2 text-right font-mono text-muted-foreground">
                                {formatNumber(parseFloat(String(item.originalQuantity)), 0)}
                              </td>
                              <td
                                className={`p-2 text-right font-mono font-semibold ${
                                  delta > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"
                                }`}
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
        </CardContent>
      )}
    </Card>
  );
}
