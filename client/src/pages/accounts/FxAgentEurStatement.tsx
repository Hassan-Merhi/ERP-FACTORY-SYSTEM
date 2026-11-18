import { Clock, FileDown, FileSpreadsheet, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { PeriodFilterValue } from "@/components/ui/period-filter";
import {
  FxAgentEurStatementAlertDialogSection,
  FxAgentEurStatementDialogSection,
  eur,
  fxEurStatementUrl,
  useFxAgentEurStatementState,
} from "./fxEurStatementUrl";
export { fxEurStatementUrl } from "./fxEurStatementUrl";

/** Native EUR operations only; historical USD GL is shown in the other tab. */
export function FxAgentEurStatement(props: {
  walletId: number;
  periodFilter: PeriodFilterValue;
  hideBalances: boolean;
}) {
  const {
    allSelected,
    confirmDelete,
    data,
    deleteMutation,
    error,
    hideBalances,
    isPending,
    periodFilter,
    recordChanges,
    reverseId,
    reverseMutation,
    reverseReason,
    selectable,
    selectedIds,
    selectedPayments,
    setConfirmDelete,
    setReverseId,
    setReverseReason,
    setSelectedIds,
    setShowDeleted,
    showDeleted,
    toggle,
    walletId,
  } = useFxAgentEurStatementState(props);

  if (isPending) return <Skeleton className="h-44 w-full" />;
  if (error)
    return (
      <div role="alert" className="rounded-lg border border-destructive/40 p-4 text-sm text-destructive">
        {error.message}
      </div>
    );
  if (!data) return null;

  const format = (amount: string) => (hideBalances ? "••••" : "EUR " + eur(amount));
  const operations = data.rows;
  const exportUrl = (extension: string) => fxEurStatementUrl(walletId, periodFilter, extension, showDeleted);

  return (
    <section className="space-y-3" data-testid="fx-agent-eur-statement">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="font-semibold text-sm">EUR Transactions</h4>
          <p className="text-xs text-muted-foreground">
            Native EUR conversions and payments. Historical USD vouchers stay in the USD tab.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground">
            {data.fromDate || data.activatedOn} — {data.toDate}
          </span>
          {selectedPayments.length > 0 && (
            <Button
              size="sm"
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => setConfirmDelete(true)}
              data-testid="fx-agent-eur-delete-selected"
            >
              <Trash2 className="w-4 h-4 mr-1" /> Delete Selected ({selectedPayments.length})
            </Button>
          )}
          <Button
            size="sm"
            variant={showDeleted ? "secondary" : "outline"}
            onClick={() => {
              setShowDeleted((v) => !v);
              setSelectedIds(new Set());
            }}
            data-testid="fx-agent-eur-show-deleted"
          >
            <Clock className="w-4 h-4 mr-1" /> {showDeleted ? "Hide Deleted" : "Show Deleted"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => window.open(exportUrl(".pdf"), "_blank")}
            data-testid="fx-agent-export-eur-pdf"
          >
            <FileDown className="w-4 h-4 mr-1" /> EUR PDF
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => window.open(exportUrl(".xlsx"), "_blank")}
            data-testid="fx-agent-export-eur-excel"
          >
            <FileSpreadsheet className="w-4 h-4 mr-1" /> EUR Excel
          </Button>
        </div>
      </div>

      {!hideBalances && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="fx-agent-eur-summary">
          {(
            [
              ["Transactions", String(operations.filter((op) => !op.deleted).length)],
              ["EUR Debit", data.totalEurIn],
              ["EUR Credit", data.totalEurOut],
              ["EUR Closing", data.closingEur],
            ] as const
          ).map(([label, amount]) => (
            <Card key={label} className="bg-muted/20">
              <CardContent className="p-3">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="font-mono text-base font-semibold tabular-nums">
                  {label === "Transactions" ? amount : format(amount)}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <div
        className="rounded-xl border overflow-auto max-h-[70vh] hidden md:block"
        data-testid="fx-agent-eur-scroll-region"
      >
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead className="w-[40px]">
                {recordChanges.allowed && (
                  <Checkbox
                    aria-label="Select all EUR payments"
                    checked={allSelected}
                    disabled={selectable.length === 0}
                    onCheckedChange={() =>
                      setSelectedIds(allSelected ? new Set() : new Set(selectable.map((op) => op.id)))
                    }
                    data-testid="fx-agent-eur-select-all"
                  />
                )}
              </TableHead>
              <TableHead className="w-[110px] text-xs uppercase">Date</TableHead>
              <TableHead className="text-xs uppercase">Particulars</TableHead>
              <TableHead className="text-xs uppercase">Notes</TableHead>
              {!hideBalances && <TableHead className="text-right text-xs uppercase">Debit</TableHead>}
              {!hideBalances && <TableHead className="text-right text-xs uppercase">Credit</TableHead>}
              {!hideBalances && <TableHead className="text-right text-xs uppercase">Balance</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow className="bg-accent/20" data-testid="fx-agent-eur-opening">
              <TableCell />
              <TableCell colSpan={3} className="font-semibold text-sm">
                Opening Balance
              </TableCell>
              {!hideBalances && (
                <>
                  <TableCell />
                  <TableCell />
                  <TableCell className="text-right font-mono font-semibold">{format(data.openingEur)}</TableCell>
                </>
              )}
            </TableRow>
            {operations.map((op) => {
              const canDelete =
                recordChanges.allowed && op.kind === "EUR_SETTLEMENT" && !op.deleted && op.voucherId != null;
              const canReverse = recordChanges.allowed && op.kind === "USD_TO_EUR" && !op.deleted;
              return (
                <TableRow
                  key={op.id}
                  className={op.deleted ? "opacity-55" : undefined}
                  data-testid={"fx-agent-eur-operation-" + op.id}
                >
                  <TableCell>
                    {canDelete && (
                      <Checkbox
                        checked={selectedIds.has(op.id)}
                        onCheckedChange={() => toggle(op.id)}
                        aria-label={"Select EUR payment " + op.id}
                      />
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs">{op.date}</TableCell>
                  <TableCell className={"font-medium text-sm " + (op.deleted ? "line-through" : "")}>
                    {op.description}
                    <p className="text-xs text-muted-foreground">
                      {op.kind === "EUR_SETTLEMENT" ? "Payment" : op.kind === "USD_TO_EUR" ? "Conversion" : "Reversal"}
                    </p>
                    {canReverse && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs"
                        onClick={() => {
                          setReverseReason("");
                          setReverseId(op.id);
                        }}
                        data-testid={"fx-agent-eur-reverse-" + op.id}
                      >
                        <RotateCcw className="w-3 h-3 mr-1" /> Reverse conversion
                      </Button>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {op.detail && <div className="max-w-[380px] break-words">{op.detail}</div>}
                    <div>
                      USD/EUR {Number(op.rateUsdPerEur).toFixed(4)}
                      {op.voucherId ? " · Voucher #" + op.voucherId : ""}
                    </div>
                    {op.deleted && <span className="font-semibold">Deleted · Excluded from balances</span>}
                  </TableCell>
                  {!hideBalances && (
                    <TableCell className="text-right font-mono whitespace-nowrap">
                      {Number(op.eurIn) > 0 ? format(op.eurIn) : "—"}
                    </TableCell>
                  )}
                  {!hideBalances && (
                    <TableCell className="text-right font-mono whitespace-nowrap">
                      {Number(op.eurOut) > 0 ? format(op.eurOut) : "—"}
                    </TableCell>
                  )}
                  {!hideBalances && (
                    <TableCell className="text-right font-mono font-semibold whitespace-nowrap">
                      {op.deleted ? "—" : format(op.balance)}
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
            {operations.length === 0 && (
              <TableRow>
                <TableCell colSpan={hideBalances ? 4 : 7} className="text-center py-6 text-sm text-muted-foreground">
                  No EUR transactions in this period.
                </TableCell>
              </TableRow>
            )}
            <TableRow className="bg-muted/50 font-semibold">
              <TableCell />
              <TableCell colSpan={3}>Closing Balance</TableCell>
              {!hideBalances && (
                <>
                  <TableCell className="text-right font-mono">{format(data.totalEurIn)}</TableCell>
                  <TableCell className="text-right font-mono">{format(data.totalEurOut)}</TableCell>
                  <TableCell className="text-right font-mono">{format(data.closingEur)}</TableCell>
                </>
              )}
            </TableRow>
          </TableBody>
        </Table>
      </div>

      <div className="space-y-2 md:hidden" data-testid="fx-agent-eur-mobile-rows">
        <div className="rounded-lg border bg-muted/20 p-3 flex items-center justify-between text-sm">
          <span>Opening Balance</span>
          <span className="font-mono font-semibold">{format(data.openingEur)}</span>
        </div>
        {operations.map((op) => {
          const canDelete =
            recordChanges.allowed && op.kind === "EUR_SETTLEMENT" && !op.deleted && op.voucherId != null;
          return (
            <div key={op.id} className={"rounded-lg border p-3 space-y-2 text-sm " + (op.deleted ? "opacity-55" : "")}>
              <div className="flex items-start gap-2">
                {canDelete && (
                  <Checkbox
                    checked={selectedIds.has(op.id)}
                    onCheckedChange={() => toggle(op.id)}
                    aria-label={"Select EUR payment " + op.id}
                  />
                )}
                <div className="flex-1">
                  <p className="text-xs text-muted-foreground">
                    {op.date} ·{" "}
                    {op.kind === "EUR_SETTLEMENT" ? "Payment" : op.kind === "USD_TO_EUR" ? "Conversion" : "Reversal"}
                  </p>
                  <p className="font-medium">{op.description}</p>
                </div>
                {recordChanges.allowed && op.kind === "USD_TO_EUR" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setReverseReason("");
                      setReverseId(op.id);
                    }}
                  >
                    <RotateCcw className="w-4 h-4" />
                  </Button>
                )}
              </div>
              {op.detail && <p className="text-xs text-muted-foreground">{op.detail}</p>}
              <p className="text-xs text-muted-foreground">
                USD/EUR {Number(op.rateUsdPerEur).toFixed(4)}
                {op.voucherId ? " · Voucher #" + op.voucherId : ""}
              </p>
              {op.deleted && <p className="text-xs font-semibold">Deleted · Excluded from balances</p>}
              {!hideBalances && (
                <div className="flex justify-between font-mono text-xs">
                  <span>{Number(op.eurIn) > 0 ? "+ " + format(op.eurIn) : "− " + format(op.eurOut)}</span>
                  <span className="font-semibold">{op.deleted ? "—" : format(op.balance)}</span>
                </div>
              )}
            </div>
          );
        })}
        {operations.length === 0 && (
          <p className="py-4 text-center text-sm text-muted-foreground">No EUR transactions in this period.</p>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Native EUR is not additional USD cash. Deleted payments are retained in the audit log and excluded from
        balances.
      </p>

      <FxAgentEurStatementAlertDialogSection
        confirmDelete={confirmDelete}
        deleteMutation={deleteMutation}
        selectedPayments={selectedPayments}
        setConfirmDelete={setConfirmDelete}
      />

      <FxAgentEurStatementDialogSection
        reverseId={reverseId}
        reverseMutation={reverseMutation}
        reverseReason={reverseReason}
        setReverseId={setReverseId}
        setReverseReason={setReverseReason}
      />
    </section>
  );
}
