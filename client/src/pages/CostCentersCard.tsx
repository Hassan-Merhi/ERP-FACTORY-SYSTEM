// Extracted from ./CostCenters.tsx
import { Button } from "@/components/ui/button";
import { PeriodFilter } from "@/components/ui/period-filter";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { useCostCentersState } from "./useCostCentersState";

export function CostCentersCard({
  activity,
  activityFrom,
  activityOffset,
  activityTo,
  balance,
  isFactory,
  loadingActivity,
  loadingBalance,
  navigate,
  selected,
  setActivityFrom,
  setActivityOffset,
  setActivityTo,
}: Pick<
  ReturnType<typeof useCostCentersState>,
  | "activity"
  | "activityFrom"
  | "activityOffset"
  | "activityTo"
  | "balance"
  | "isFactory"
  | "loadingActivity"
  | "loadingBalance"
  | "navigate"
  | "selected"
  | "setActivityFrom"
  | "setActivityOffset"
  | "setActivityTo"
>) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Center Activity</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!selected && (
          <p className="text-sm text-muted-foreground">
            Select a cost center to view its allocations and source vouchers.
          </p>
        )}
        {selected && (
          <>
            <div>
              <div className="font-semibold">{selected.name}</div>
              <div className="text-sm text-muted-foreground">
                {selected.code} · {selected.active ? "Active" : "Archived"}
              </div>
              {selected.description && <p className="text-sm mt-1">{selected.description}</p>}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {(balance?.byTreatment || []).map((row) => (
                <div key={row.costTreatment} className="rounded-md border p-3">
                  <p className="text-xs text-muted-foreground">
                    {row.costTreatment === "INVENTORY_COST" ? "Capitalized / inventory" : row.costTreatment}
                  </p>
                  <p className="font-mono font-semibold">
                    USD{" "}
                    {Number(row.amountBase).toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </p>
                  <p className="text-xs text-muted-foreground">{row.entryCount} allocations</p>
                </div>
              ))}
            </div>
            {loadingBalance && <p className="text-xs text-muted-foreground">Loading totals…</p>}
            {loadingActivity && <p className="text-xs text-muted-foreground">Loading activity…</p>}
            <div className="flex flex-wrap gap-2 items-center">
              <PeriodFilter
                value={{
                  fromDate: activityFrom,
                  toDate: activityTo,
                  preset: activityFrom || activityTo ? "custom" : "all_time",
                }}
                onChange={(v) => {
                  setActivityFrom(v.fromDate);
                  setActivityTo(v.toDate);
                  setActivityOffset(0);
                }}
                data-testid="cost-center-activity-period"
              />
            </div>
            <div className="space-y-1">
              {(activity?.activity || []).map((row) => (
                <div key={row.id} className="border-b py-2 flex items-start justify-between gap-2 text-sm">
                  <div>
                    {row.voucherId ? (
                      <button
                        type="button"
                        className="font-medium text-primary hover:underline text-left"
                        onClick={() =>
                          navigate((isFactory ? "/factory/voucher-detail/" : "/voucher-detail/") + row.voucherId)
                        }
                      >
                        {row.voucherNumber || "Voucher #" + row.voucherId}
                      </button>
                    ) : row.factoryDaybookEntryId && isFactory ? (
                      <button
                        className="font-medium text-primary hover:underline text-left"
                        type="button"
                        onClick={() => navigate("/factory/daybook?entryId=" + row.factoryDaybookEntryId)}
                      >
                        {row.factoryTxType || "Factory daybook entry"} #{row.factoryDaybookEntryId}
                      </button>
                    ) : (
                      <p className="font-medium">{row.factoryTxType || "Entry #" + row.id}</p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {row.sourceDate ? String(row.sourceDate).slice(0, 10) : "Date unavailable"} · {row.costTreatment}{" "}
                      · {row.allocationOrigin === "AUTO" ? "Automatic" : "Manual"}
                    </p>
                    {row.voucherEntryId && (
                      <p className="text-xs text-muted-foreground">Voucher entry #{row.voucherEntryId}</p>
                    )}
                  </div>
                  <span className="font-mono shrink-0">USD {Number(row.amountBase).toFixed(2)}</span>
                </div>
              ))}
              {!loadingActivity && activity?.activity?.length === 0 && (
                <p className="text-sm text-muted-foreground">No allocated transactions in this date range.</p>
              )}
            </div>
            <div className="flex justify-between gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!activityOffset || loadingActivity}
                onClick={() => setActivityOffset((v) => Math.max(0, v - 50))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={loadingActivity || (activity?.activity?.length || 0) < 50}
                onClick={() => setActivityOffset((v) => v + 50)}
              >
                Next
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
