import { ArrowLeft, Loader2, Save, CheckCircle2, ArrowRight, Clock, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import type { PosUser, TransferDetail } from "../types";
import { fmtQty, formatDate, formatDateTime } from "../utils";
import { ItemSearchPanel } from "./ItemSearchPanel";
import { useEditableTransferDetailState } from "./useEditableTransferDetailState";
import { EditableTransferDetailSection } from "./EditableTransferDetailSection";

export // ─── Editable detail view ─────────────────────────────────────────────────────
function EditableTransferDetail(props: {
  detail: TransferDetail;
  posUser: PosUser;
  voucherId: number;
  onBack: () => void;
}) {
  const {
    addExtraItem,
    deltaRefs,
    deltas,
    detail,
    extraItems,
    focusRelative,
    getDeltaNum,
    handleSave,
    hasChanges,
    myItems,
    normalizeDelta,
    note,
    onBack,
    openPanel,
    panelActiveIdx,
    panelMatches,
    panelOpen,
    panelSearch,
    removeExtra,
    revisionMutation,
    searchBarRef,
    setDeltaVal,
    setNote,
    setPanelActiveIdx,
    setPanelOpen,
    setPanelSearch,
    totalItems,
    updateExtraQty,
  } = useEditableTransferDetailState(props);

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ── */}
      <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted/20">
        <Button variant="ghost" size="icon" onClick={onBack} data-testid="button-back-to-list">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground">{formatDate(detail.voucherDate)}</span>
            {detail.inventoryApplied && (
              <Badge
                variant="secondary"
                className="text-xs gap-1 text-green-700 dark:text-green-400 bg-green-100 dark:bg-green-900/30"
              >
                <Lock className="h-3 w-3" />
                Applied
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="text-sm text-muted-foreground">{detail.sourceLocationName}</span>
            <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
            <span className="text-sm font-semibold">{detail.destinationLocationName}</span>
          </div>
        </div>
      </div>

      {/* ── Main content ── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left: scrollable content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Table */}
          <EditableTransferDetailSection
            addExtraItem={addExtraItem}
            deltaRefs={deltaRefs}
            deltas={deltas}
            extraItems={extraItems}
            focusRelative={focusRelative}
            getDeltaNum={getDeltaNum}
            hasChanges={hasChanges}
            myItems={myItems}
            normalizeDelta={normalizeDelta}
            openPanel={openPanel}
            panelActiveIdx={panelActiveIdx}
            panelMatches={panelMatches}
            panelOpen={panelOpen}
            panelSearch={panelSearch}
            removeExtra={removeExtra}
            searchBarRef={searchBarRef}
            setDeltaVal={setDeltaVal}
            setPanelActiveIdx={setPanelActiveIdx}
            setPanelOpen={setPanelOpen}
            setPanelSearch={setPanelSearch}
            totalItems={totalItems}
            updateExtraQty={updateExtraQty}
          />

          {/* Notes + Save */}
          <div className="flex flex-col sm:flex-row gap-3 items-start">
            <Textarea
              placeholder="Notes (optional)..."
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              className="resize-none text-sm flex-1"
              data-testid="textarea-revision-note"
            />
            <Button
              type="button"
              onClick={handleSave}
              disabled={!hasChanges || revisionMutation.isPending}
              className="w-full sm:w-auto shrink-0"
              data-testid="button-save-revision"
            >
              {revisionMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="h-4 w-4 mr-1.5" />
                  Save Revision
                </>
              )}
            </Button>
          </div>

          {/* Revision history */}
          {(detail.revisions?.length ?? 0) > 0 && (
            <div className="space-y-2 pb-4">
              <div className="flex items-center gap-2">
                <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Revision History
                </span>
              </div>
              {detail.revisions.map((rev) => {
                const revLocName = rev.items[0]?.sourceLocationName ?? null;
                return (
                  <Card key={rev.id} data-testid={`card-revision-${rev.id}`}>
                    <CardContent className="pt-3 pb-3 space-y-2">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold">Revision #{rev.revisionNumber}</span>
                          {revLocName && (
                            <span className="text-xs text-muted-foreground">
                              · From: <span className="font-medium text-foreground">{revLocName}</span>
                            </span>
                          )}
                          <span className="text-xs text-muted-foreground">{formatDateTime(rev.createdAt)}</span>
                        </div>
                        {rev.optional ? (
                          <Badge variant="outline" className="text-xs" data-testid={`badge-pending-${rev.id}`}>
                            Pending Admin Review
                          </Badge>
                        ) : (
                          <Badge variant="default" className="text-xs" data-testid={`badge-approved-${rev.id}`}>
                            <CheckCircle2 className="h-3 w-3 mr-1" />
                            Approved
                          </Badge>
                        )}
                      </div>
                      {rev.note && <p className="text-xs text-muted-foreground italic">{rev.note}</p>}
                      <div className="rounded-md border overflow-hidden">
                        <div className="grid grid-cols-[1fr_auto_auto_auto] bg-muted/30 border-b px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide gap-x-4">
                          <span>Item</span>
                          <span className="text-right">Was</span>
                          <span className="text-right">Now</span>
                          <span className="text-right">Change</span>
                        </div>
                        {rev.items
                          .filter((ri) => parseFloat(ri.delta) !== 0)
                          .map((ri, i) => {
                            const delta = parseFloat(ri.delta);
                            return (
                              <div
                                key={i}
                                className="grid grid-cols-[1fr_auto_auto_auto] items-center px-3 py-2 text-xs gap-x-4 bg-card border-b last:border-b-0"
                                data-testid={`text-rev-item-${rev.id}-${i}`}
                              >
                                <span className="font-medium">{ri.stockItemName}</span>
                                <span className="font-mono text-right text-muted-foreground">
                                  {fmtQty(ri.originalQuantity)}
                                </span>
                                <span className="font-mono font-semibold text-right">{fmtQty(ri.newQuantity)}</span>
                                <span
                                  className={cn(
                                    "font-mono font-semibold text-right",
                                    delta > 0 ? "text-green-600 dark:text-green-400" : "text-destructive"
                                  )}
                                >
                                  {delta > 0 ? "+" : ""}
                                  {fmtQty(ri.delta)}
                                </span>
                              </div>
                            );
                          })}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>

        {/* Spacer: reserves room for the fixed panel on desktop so content doesn't slide under it */}
        {panelOpen && <div className="hidden sm:block w-64 shrink-0" />}
      </div>

      {/* Fixed item-search panel — right panel on sm+, bottom sheet on mobile */}
      {panelOpen && (
        <>
          {/* Desktop: fixed right panel */}
          <div className="hidden sm:flex fixed right-0 top-12 bottom-0 w-64 z-30 bg-card border-l flex-col shadow-md overflow-hidden">
            <ItemSearchPanel
              matches={panelMatches}
              activeIdx={panelActiveIdx}
              locationName={detail.sourceLocationName}
              onActiveChange={setPanelActiveIdx}
              onPick={addExtraItem}
              onClose={() => {
                setPanelOpen(false);
                setPanelSearch("");
              }}
            />
          </div>
          {/* Mobile: bottom sheet */}
          <div
            className="sm:hidden fixed inset-x-0 bottom-0 z-40 bg-card border-t flex flex-col shadow-lg"
            style={{ height: "55vh" }}
          >
            <ItemSearchPanel
              matches={panelMatches}
              activeIdx={panelActiveIdx}
              locationName={detail.sourceLocationName}
              onActiveChange={setPanelActiveIdx}
              onPick={addExtraItem}
              onClose={() => {
                setPanelOpen(false);
                setPanelSearch("");
              }}
            />
          </div>
          {/* Mobile backdrop */}
          <div
            className="sm:hidden fixed inset-0 z-30 bg-black/30"
            onClick={() => {
              setPanelOpen(false);
              setPanelSearch("");
            }}
          />
        </>
      )}
    </div>
  );
}
