import { FileWarning, Loader2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { confirmAction } from "@/components/ConfirmHost";
import {
  errorMessage,
  roleCanManage,
  useFactoryLoadingDispatchFinanceState,
  type Props,
} from "./useFactoryLoadingDispatchFinanceState";
import { FactoryLoadingDispatchFinanceDispatchTripChargeForm } from "./FactoryLoadingDispatchFinanceDispatchTripChargeForm";
const money = (value: string | undefined) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed)
    ? parsed.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "—";
};

export default function FactoryLoadingDispatchFinance(props: Props) {
  const {
    beginCreate,
    beginEdit,
    busy,
    canEdit,
    data,
    editingId,
    enabled,
    form,
    formOpen,
    mainAccounts,
    offsetAccounts,
    preview,
    remove,
    role,
    save,
    setEditingId,
    setForm,
    setFormOpen,
    status,
    validForm,
  } = useFactoryLoadingDispatchFinanceState(props);

  return (
    <Card
      className="border-slate-200 bg-white dark:border-slate-700 dark:bg-card"
      data-testid="dispatch-trip-financial-preview"
    >
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Trip finances</h3>
          <Badge variant="outline">{data?.status ?? "Not posted"}</Badge>
        </div>

        {status !== "CLOSED" && (
          <p className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
            End Dispatch to review its signed bale amounts and add financial charges.
          </p>
        )}
        {status === "CLOSED" && !roleCanManage(role) && (
          <p className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
            Financial charge management requires Admin, Owner or Developer access.
          </p>
        )}
        {enabled && preview.isPending && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading signed trip totals…
          </p>
        )}
        {enabled && preview.isError && (
          <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
            <p className="flex items-start gap-2">
              <FileWarning className="h-4 w-4 shrink-0" />
              {errorMessage(preview.error)}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={() => void preview.refetch()}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Retry
            </Button>
          </div>
        )}
        {enabled && data && (
          <>
            {data.sourceError && (
              <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                {data.sourceError.message}. Financial changes are blocked until the signed trip is reconciled.
              </p>
            )}
            {data.source && data.totals && (
              <div className="space-y-2 rounded-lg border p-3 text-xs">
                <div className="flex justify-between gap-2 text-muted-foreground">
                  <span>Loaded</span>
                  <span>
                    {data.source.baleCount} {data.source.baleCount === 1 ? "bale" : "bales"} ·{" "}
                    {data.source.totalWeightKg} kg
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span>Goods</span>
                  <span className="font-mono">$ {money(data.totals.goodsSubtotal)}</span>
                </div>
                {Number(data.totals.billableChargesTotal) !== 0 && (
                  <div className="flex justify-between gap-2">
                    <span>Billable charges</span>
                    <span className="font-mono">+ $ {money(data.totals.billableChargesTotal)}</span>
                  </div>
                )}
                {Number(data.totals.discountTotal) !== 0 && (
                  <div className="flex justify-between gap-2">
                    <span>Discounts</span>
                    <span className="font-mono">− $ {money(data.totals.discountTotal)}</span>
                  </div>
                )}
                <div className="flex justify-between gap-2 border-t pt-2 font-semibold">
                  <span>Customer total</span>
                  <span className="font-mono">$ {money(data.totals.customerTotal)}</span>
                </div>
                {Number(data.totals.internalExpenseTotal) !== 0 && (
                  <div className="flex justify-between gap-2 text-muted-foreground">
                    <span>Internal expenses (not billed)</span>
                    <span className="font-mono">$ {money(data.totals.internalExpenseTotal)}</span>
                  </div>
                )}
              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold">Charges ({data.charges.length})</span>
                {canEdit && !formOpen && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={beginCreate}
                    data-testid="dispatch-add-financial-charge"
                  >
                    <Plus className="mr-1 h-3.5 w-3.5" /> Add charge
                  </Button>
                )}
              </div>
              {data.charges.length === 0 && (
                <p className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">No charges added yet.</p>
              )}
              {data.charges.map((c) => {
                const account = data.accounts.find((a) => a.id === c.ledgerAccountId);
                return (
                  <div
                    key={c.id}
                    className="rounded-lg border p-3 text-xs"
                    data-testid={"dispatch-financial-charge-" + c.id}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold">{c.name}</p>
                        <p className="text-muted-foreground">
                          {c.kind === "BILLABLE" ? "Billable" : c.kind === "INTERNAL" ? "Internal expense" : "Discount"}{" "}
                          · {account?.name ?? "Ledger account"}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="font-mono font-semibold">$ {money(c.amount)}</p>
                        {canEdit && !formOpen && !c.lockedAt && (
                          <div className="mt-1 flex gap-1">
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label={"Edit " + c.name}
                              disabled={busy}
                              onClick={() => beginEdit(c)}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label={"Remove " + c.name}
                              disabled={busy}
                              onClick={async () => {
                                const confirmed = await confirmAction({
                                  title: "Remove this draft charge?",
                                  confirmText: "Remove",
                                  tone: "destructive",
                                });
                                if (confirmed) remove.mutate(c.id);
                              }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                    {c.notes && <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{c.notes}</p>}
                  </div>
                );
              })}
            </div>

            {canEdit && formOpen && (
              <FactoryLoadingDispatchFinanceDispatchTripChargeForm
                busy={busy}
                editingId={editingId}
                form={form}
                mainAccounts={mainAccounts}
                offsetAccounts={offsetAccounts}
                save={save}
                setEditingId={setEditingId}
                setForm={setForm}
                setFormOpen={setFormOpen}
                validForm={validForm}
              />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
