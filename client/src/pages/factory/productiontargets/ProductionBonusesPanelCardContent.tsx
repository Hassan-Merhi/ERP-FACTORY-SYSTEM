// Extracted from ./ProductionBonusesPanel.tsx
import { LockKeyhole, SlidersHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { count, money, rowKey } from "./ProductionBonusesPanelTypes";
import { useProductionBonusesPanelState } from "./useProductionBonusesPanelState";
import { ProductionBonusesPanelSection, ProductionBonusesPanelSection2 } from "./ProductionBonusesPanelSection";

export function ProductionBonusesPanelCardContent({
  allVisibleSelected,
  canApproveSelected,
  data,
  eligible,
  end,
  error,
  filter,
  isLoading,
  rangeValid,
  reviewMutation,
  search,
  selected,
  selectedAmount,
  selectedRows,
  setConfirmDecision,
  setEnd,
  setFilter,
  setRateDate,
  setRateInput,
  setRateWorker,
  setSearch,
  setSelected,
  setStart,
  start,
  visible,
  workerBreakdown,
}: Pick<
  ReturnType<typeof useProductionBonusesPanelState>,
  | "allVisibleSelected"
  | "canApproveSelected"
  | "data"
  | "eligible"
  | "end"
  | "error"
  | "filter"
  | "isLoading"
  | "rangeValid"
  | "reviewMutation"
  | "search"
  | "selected"
  | "selectedAmount"
  | "selectedRows"
  | "setConfirmDecision"
  | "setEnd"
  | "setFilter"
  | "setRateDate"
  | "setRateInput"
  | "setRateWorker"
  | "setSearch"
  | "setSelected"
  | "setStart"
  | "start"
  | "visible"
  | "workerBreakdown"
>) {
  return (
    <CardContent className="space-y-4 pt-4">
      <ProductionBonusesPanelSection
        end={end}
        filter={filter}
        search={search}
        setEnd={setEnd}
        setFilter={setFilter}
        setSearch={setSearch}
        setSelected={setSelected}
        setStart={setStart}
        start={start}
      />
      {!rangeValid && (
        <p role="alert" className="text-sm text-destructive">
          Choose a valid range of up to 32 days.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {(error as Error).message}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {[
          ["Extra bales", count(data?.totals.extraBales ?? 0)],
          ["Pending review", String(data?.totals.pendingCount ?? 0)],
          ["Pending bonus", money(data?.totals.pendingAmount ?? 0)],
          ["Approved bonus", money(data?.totals.approvedAmount ?? 0)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border bg-muted/10 px-3 py-3">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
          </div>
        ))}
      </div>
      {workerBreakdown.length > 0 && (
        <details className="rounded-md border bg-muted/10">
          <summary className="cursor-pointer px-3 py-2.5 text-sm font-medium">
            Worker totals across selected dates ({workerBreakdown.length} workers)
          </summary>
          <div className="overflow-x-auto border-t">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Worker</TableHead>
                  <TableHead className="text-right">Target</TableHead>
                  <TableHead className="text-right">Produced</TableHead>
                  <TableHead className="text-right">Extra</TableHead>
                  <TableHead className="text-right">Pending</TableHead>
                  <TableHead className="text-right">Approved</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workerBreakdown.map((worker) => (
                  <TableRow key={worker.workerId}>
                    <TableCell className="font-medium">{worker.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{count(worker.target)}</TableCell>
                    <TableCell className="text-right tabular-nums">{count(worker.produced)}</TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">{count(worker.extra)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(worker.pending)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(worker.approved)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </details>
      )}
      {data?.canDecide && (
        <ProductionBonusesPanelSection2
          allVisibleSelected={allVisibleSelected}
          canApproveSelected={canApproveSelected}
          eligible={eligible}
          reviewMutation={reviewMutation}
          selected={selected}
          selectedAmount={selectedAmount}
          selectedRows={selectedRows}
          setConfirmDecision={setConfirmDecision}
          setSelected={setSelected}
        />
      )}
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              {data?.canDecide && <TableHead className="w-10">Select</TableHead>}
              <TableHead>Date / Worker</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">Target</TableHead>
              <TableHead className="text-right">Made</TableHead>
              <TableHead className="text-right">Extra</TableHead>
              <TableHead className="text-right">Rate / bale</TableHead>
              <TableHead className="text-right">Bonus</TableHead>
              <TableHead>Status / Audit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                  Loading production bonuses...
                </TableCell>
              </TableRow>
            ) : visible.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                  No production bonus records for the selected dates.
                </TableCell>
              </TableRow>
            ) : (
              visible.map((row) => {
                const actionable = row.status === "pending" && row.extraBales > 0 && row.targetConfigured !== false;
                return (
                  <TableRow key={rowKey(row)}>
                    {data?.canDecide && (
                      <TableCell>
                        <Checkbox
                          aria-label={`Select ${row.workerName} on ${row.date}`}
                          checked={selected.includes(rowKey(row))}
                          disabled={!actionable}
                          onCheckedChange={(checked) =>
                            setSelected((previous) =>
                              checked
                                ? Array.from(new Set([...previous, rowKey(row)]))
                                : previous.filter((key) => key !== rowKey(row))
                            )
                          }
                        />
                      </TableCell>
                    )}
                    <TableCell>
                      <p className="font-medium">{row.workerName}</p>
                      <p className="text-xs text-muted-foreground">
                        {row.date}
                        {row.linkGroupId != null && " · linked worker"}
                        {row.sourceFinalized === false && " · Live production"}
                      </p>
                    </TableCell>
                    <TableCell>{row.category || "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{count(row.targetBales)}</TableCell>
                    <TableCell className="text-right tabular-nums">{count(row.producedBales)}</TableCell>
                    <TableCell
                      className={`text-right font-semibold tabular-nums ${row.extraBales > 0 ? "text-emerald-600" : ""}`}
                    >
                      {count(row.extraBales)}
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="tabular-nums">
                        {row.ratePerBale == null ? "Not set" : money(row.ratePerBale)}
                      </span>
                      {data?.canDecide && row.status === "pending" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="ml-1 h-7 px-1.5"
                          title="Change effective-dated per-bale rate"
                          onClick={() => {
                            setRateWorker(row);
                            setRateInput(row.ratePerBale?.toString() ?? "");
                            setRateDate(row.date);
                          }}
                        >
                          <SlidersHorizontal className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">
                      {row.status === "rejected"
                        ? money(0)
                        : money(row.status === "approved" ? (row.lockedAmount ?? 0) : row.proposedAmount)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={row.status === "approved" ? "default" : "secondary"}>
                        {row.status === "pending" && row.extraBales === 0
                          ? "No extra bales"
                          : row.status === "pending" && row.targetConfigured === false
                            ? "Target needed"
                            : row.status === "pending" && row.ratePerBale == null
                              ? "Rate needed"
                              : row.status}
                      </Badge>
                      {row.reviewedAt && (
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          <LockKeyhole className="mr-1 inline h-3 w-3" />
                          {row.reviewedBy || "Reviewer"} · {new Date(row.reviewedAt).toLocaleString()}
                        </p>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        Live counts update until you approve. Approval freezes the worker/day target and credited bales immediately,
        even without End Production. Bales scanned afterward are not added to the approved amount. Approved payments are
        posted only from the separate Pay Bonuses step.
      </p>
    </CardContent>
  );
}
