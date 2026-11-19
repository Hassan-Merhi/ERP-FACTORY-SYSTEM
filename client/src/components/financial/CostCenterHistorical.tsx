import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, History } from "lucide-react";
import { type CostCenter } from "@/api/costCentersApi";
import { fmt } from "./CostCenterHistoricalTypes";
import { useCostCenterHistoricalState } from "./useCostCenterHistoricalState";
import { CostCenterHistoricalSection, CostCenterHistoricalSection2 } from "./CostCenterHistoricalSection2";
import { CostCenterHistoricalContent } from "./CostCenterHistoricalContent";
/** Rows drawn in the preview table; totals and Apply always cover the whole batch. */
const PREVIEW_ROWS_SHOWN = 500;

export function CostCenterHistorical(props: { baseUrl: string; centers: CostCenter[] }) {
  const {
    accounts,
    applied,
    applyWrite,
    canWrite,
    centers,
    changeSplit,
    confirmation,
    from,
    history,
    invalidatePreview,
    isFactory,
    kind,
    limit,
    pctTotal,
    preview,
    previewWrite,
    reason,
    reconError,
    reconErrorText,
    reconLoading,
    reconciliation,
    refreshHistory,
    refreshRecon,
    samePreview,
    selectedAccounts,
    setConfirmation,
    setFrom,
    setKind,
    setLimit,
    setPreview,
    setReason,
    setSelectedAccounts,
    setShowBatchHistory,
    setSplits,
    setTo,
    showBatchHistory,
    splits,
    to,
    valid,
  } = useCostCenterHistoricalState(props);
  return (
    <Card data-testid="cost-center-historical">
      <CardHeader className="space-y-2">
        <CardTitle className="flex gap-2 items-center text-base">
          <History className="w-4 h-4" /> Historical Assignment & Reconciliation
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Prior expense transactions remain Unallocated until you manually approve a specific historical batch. Existing
          manual or automatic assignments are never overwritten. Preview does not touch accounting; Apply creates
          analytical cost-center tags only.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <CostCenterHistoricalContent
          accounts={accounts}
          from={from}
          invalidatePreview={invalidatePreview}
          isFactory={isFactory}
          kind={kind}
          limit={limit}
          selectedAccounts={selectedAccounts}
          setFrom={setFrom}
          setKind={setKind}
          setLimit={setLimit}
          setSelectedAccounts={setSelectedAccounts}
          setTo={setTo}
          to={to}
        />
        <CostCenterHistoricalSection
          reconError={reconError}
          reconErrorText={reconErrorText}
          reconLoading={reconLoading}
          reconciliation={reconciliation}
          refreshRecon={refreshRecon}
        />
        {canWrite && (
          <CostCenterHistoricalSection2
            applyWrite={applyWrite}
            centers={centers}
            changeSplit={changeSplit}
            invalidatePreview={invalidatePreview}
            pctTotal={pctTotal}
            previewWrite={previewWrite}
            reason={reason}
            setReason={setReason}
            setSplits={setSplits}
            splits={splits}
            valid={valid}
          />
        )}
        {preview && (
          <div className="rounded-md border p-3 space-y-3">
            <div className="flex flex-wrap justify-between gap-2 items-center">
              <h3 className="font-semibold text-sm">Dry Run — {preview.candidateCount} Sources</h3>
              <Badge variant="secondary">No allocations written</Badge>
            </div>
            <p className="text-sm">
              Historical source USD {fmt(preview.sourceUsdTotal)}; planned allocation USD{" "}
              {fmt(preview.allocatedUsdTotal)}. Native currencies are preserved individually by source.
            </p>
            <p className="text-xs text-muted-foreground">
              Preview expires after {preview.expiresInMinutes} minutes. Source changes invalidate it immediately. Apply
              is all-or-nothing.
            </p>
            <div className="max-h-64 overflow-auto rounded border">
              <table className="text-xs w-full min-w-[560px]">
                <thead className="bg-muted/40 sticky top-0">
                  <tr>
                    <th className="text-left p-2">Date / Source</th>
                    <th className="text-left p-2">Account</th>
                    <th className="text-right p-2">Original value</th>
                    <th className="text-right p-2">Book USD</th>
                    <th className="text-right p-2">Allocation USD</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, PREVIEW_ROWS_SHOWN).map((row) => (
                    <tr key={row.sourceId} className="border-t">
                      <td className="p-2">
                        {row.sourceDate?.slice(0, 10)}
                        <p>{row.voucherNumber || "Daybook #" + row.sourceId}</p>
                      </td>
                      <td className="p-2">{row.accountName}</td>
                      <td className="p-2 text-right">
                        {row.currency} {fmt(row.amountNative)}
                      </td>
                      <td className="p-2 text-right">{fmt(row.amountUsd)}</td>
                      <td className="p-2 text-right">
                        {fmt(row.allocations.reduce((s, a) => s + Number(a.amountUsd), 0))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.rows.length > PREVIEW_ROWS_SHOWN && (
              <p className="text-xs text-muted-foreground">
                Showing the first {PREVIEW_ROWS_SHOWN} of {preview.candidateCount} entries; totals and Apply cover all
                of them.
              </p>
            )}
            <div className="rounded-md border border-destructive/30 p-3 space-y-2">
              <p className="text-sm flex gap-2 items-center font-semibold">
                <AlertTriangle className="h-4 w-4" />
                Confirm historical assignment
              </p>
              <p className="text-xs text-muted-foreground">
                This writes analytical allocation records for all {preview.candidateCount} sources. It cannot alter
                posted vouchers. To proceed, enter <strong>APPLY</strong>. Existing assignments are never overwritten.
              </p>
              <div className="flex flex-wrap gap-2">
                <Input
                  aria-label="Type APPLY to confirm"
                  placeholder="Type APPLY"
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  className="max-w-44"
                />
                <Button disabled={!samePreview || confirmation !== "APPLY"} onClick={() => applyWrite.mutate()}>
                  {applyWrite.isPending ? "Applying…" : "Apply Approved Batch"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setPreview(null);
                    setConfirmation("");
                  }}
                >
                  Discard Preview
                </Button>
              </div>
            </div>
          </div>
        )}
        {applied && (
          <p role="status" className="text-sm font-medium">
            Applied {applied.sourceCount} historical source allocations, USD {fmt(applied.allocatedUsdTotal)}. No
            vouchers or accounting balances were changed.
          </p>
        )}
        <div className="space-y-2 border-t pt-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setShowBatchHistory((v) => !v);
              void refreshHistory();
            }}
          >
            {showBatchHistory ? "Hide" : "Show"} Recent Historical Batches
          </Button>
          {showBatchHistory && (
            <div className="space-y-1">
              {(history?.batches || []).map((row) => (
                <div key={row.id} className="border-b text-sm py-2 flex flex-wrap justify-between gap-2">
                  <div>
                    <span className="font-medium">
                      {row.sourceKind === "VOUCHER_ENTRY" ? "Vouchers" : "Factory Daybook"}
                    </span>
                    <p className="text-xs text-muted-foreground">
                      {row.request.fromDate} – {row.request.toDate}
                      {" · "}
                      {row.candidateCount} sources · USD {fmt(row.sourceUsdTotal)}
                    </p>
                    <p className="text-xs text-muted-foreground">{row.request.reason}</p>
                  </div>
                  <Badge variant="secondary">
                    {row.status === "PREVIEW" && new Date(row.expiresAt).getTime() < Date.now()
                      ? "EXPIRED"
                      : row.status}
                  </Badge>
                </div>
              ))}
              {history?.batches.length === 0 && (
                <p className="text-xs text-muted-foreground">No historical batches saved.</p>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
