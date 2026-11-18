import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle, History } from "lucide-react";
import { type CostCenter } from "@/api/costCentersApi";
import { MultiSelectFilter } from "@/pages/factory/productioncomparison/components/MultiSelectFilter";
import { MAX_BATCH, fmt, type Kind } from "./CostCenterHistoricalTypes";
import { useCostCenterHistoricalState } from "./useCostCenterHistoricalState";
import { CostCenterHistoricalSection, CostCenterHistoricalSection2 } from "./CostCenterHistoricalSection2";
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
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
          <div className="space-y-1">
            <Label>Historical Source</Label>
            <Select
              value={kind}
              onValueChange={(v) => {
                invalidatePreview();
                setKind(v as Kind);
                setSelectedAccounts([]);
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="VOUCHER_ENTRY">Posted expense voucher lines</SelectItem>
                {isFactory && <SelectItem value="FACTORY_DAYBOOK">Standalone Factory expenses</SelectItem>}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="historical-cc-from">From</Label>
            <Input
              id="historical-cc-from"
              type="date"
              value={from}
              onChange={(e) => {
                invalidatePreview();
                setFrom(e.target.value);
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="historical-cc-to">To</Label>
            <Input
              id="historical-cc-to"
              type="date"
              value={to}
              onChange={(e) => {
                invalidatePreview();
                setTo(e.target.value);
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="historical-cc-limit">Maximum entries (1–10,000)</Label>
            <Input
              id="historical-cc-limit"
              type="number"
              min={1}
              max={MAX_BATCH}
              step={1}
              value={limit}
              onChange={(e) => {
                invalidatePreview();
                setLimit(e.target.value);
              }}
            />
          </div>
          {kind === "VOUCHER_ENTRY" && (
            <div className="space-y-1 sm:col-span-2">
              <Label>Expense Ledger Accounts (optional)</Label>
              <MultiSelectFilter
                className="w-full"
                contentClassName="w-[min(28rem,90vw)]"
                testId="historical-cc-accounts"
                options={(accounts?.accounts || []).map((a) => ({
                  value: String(a.id),
                  label: a.code + " — " + a.name,
                }))}
                selected={selectedAccounts}
                onChange={(next) => {
                  invalidatePreview();
                  setSelectedAccounts(next);
                }}
                placeholder="Expense accounts"
                allLabel="All Eligible Expense Accounts"
              />
            </div>
          )}
        </div>
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
