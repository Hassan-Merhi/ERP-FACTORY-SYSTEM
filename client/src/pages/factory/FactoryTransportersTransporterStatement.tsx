// Extracted from ./FactoryTransporters.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useRef, useState } from "react";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useAdminOverride } from "@/hooks/use-admin-override";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { useReactToPrint } from "react-to-print";
import { DeleteConfirmDialog } from "@/components/ConfirmationDialog";
import { API, ChargeDialog, PaymentDialog, fmt, type TransporterDetail } from "./FactoryTransportersPaymentDialog";

// ─────────────────────────────────────────────────────────────
// STATEMENT VIEW (detail page)
// ─────────────────────────────────────────────────────────────
export function TransporterStatement({ transporterId, onBack }: { transporterId: number; onBack: () => void }) {
  const { selectedCompany } = useCompany();
  const { wrapAdminAction, AdminDialog } = useAdminOverride();
  const { toast } = useToast();
  const [chargeOpen, setChargeOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<(() => void) | null>(null);
  const printRef = useRef<HTMLDivElement>(null);
  // Charges and payments post to an existing transporter's ledger; read-only roles view and print only.
  const recordChanges = useExistingRecordChangeAccess();

  const { data, isLoading } = useQuery<TransporterDetail>({
    queryKey: companyQueryKey(API, selectedCompany?.id, transporterId),
    enabled: Boolean(selectedCompany?.id),
    queryFn: () => fetch(`${API}/${transporterId}`, { credentials: "include" }).then((r) => r.json()),
  });

  const deleteTx = useMutation({
    mutationFn: async (txId: number) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return apiRequest("DELETE", `${API}/${transporterId}/transactions/${txId}`);
    },
    onSuccess: () => {
      toast({ title: "Entry deleted" });
      queryClient.invalidateQueries({ queryKey: [API] });
      queryClient.invalidateQueries({ queryKey: companyQueryKey(API, selectedCompany?.id, transporterId) });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  const handlePrint = useReactToPrint({ contentRef: printRef });

  if (isLoading) return <div className="p-8 text-center text-muted-foreground">Loading statement…</div>;
  if (!data) return <div className="p-8 text-center text-muted-foreground">Transporter not found.</div>;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={onBack} data-testid="button-back-transporters">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h2 className="text-xl font-bold">{data.name}</h2>
            {data.phone && <p className="text-sm text-muted-foreground">{data.phone}</p>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ExportButton
            kind="print"
            variant="outline"
            size="sm"
            onClick={() => handlePrint()}
            data-testid="button-print-statement"
          />
          {recordChanges.allowed && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPaymentOpen(true)}
                data-testid="button-record-payment"
              >
                Record Payment
              </Button>
              <Button size="sm" onClick={() => setChargeOpen(true)} data-testid="button-record-charge">
                <Plus className="h-4 w-4 mr-1" /> Record Charge
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground font-normal">TOTAL CHARGED</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${fmt(data.totalCharged)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground font-normal">TOTAL PAID</CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${data.totalPaid > 0 ? "text-green-600 dark:text-green-400" : ""}`}>
              ${fmt(data.totalPaid)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground font-normal">OUTSTANDING</CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className={`text-2xl font-bold ${data.outstanding > 0 ? "text-red-600 dark:text-red-400" : data.outstanding < 0 ? "text-green-600 dark:text-green-400" : ""}`}
            >
              ${fmt(data.outstanding)}
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">positive = you owe them</p>
          </CardContent>
        </Card>
      </div>

      {/* Statement table */}
      <Card>
        <div ref={printRef} className="p-4">
          <div className="hidden print:block mb-4">
            <h2 className="text-lg font-bold">Transporter Statement — {data.name}</h2>
            {data.phone && <p className="text-sm">{data.phone}</p>}
          </div>
          <div className="table-responsive">
            {data.transactions.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground">
                No transactions yet. Record a charge to get started.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-30 bg-muted">
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Date</th>
                    <th className="px-3 py-2 font-medium">Type</th>
                    <th className="px-3 py-2 font-medium">Description</th>
                    <th className="px-3 py-2 text-right font-medium">Charge</th>
                    <th className="px-3 py-2 text-right font-medium">Payment</th>
                    <th className="px-3 py-2 text-right font-medium">Balance</th>
                    <th className="px-3 py-2 print:hidden"></th>
                  </tr>
                </thead>
                <tbody>
                  {data.transactions.map((tx) => (
                    <tr key={tx.id} className="border-b hover:bg-muted/30">
                      <td className="px-3 py-2 tabular-nums">{tx.txDate}</td>
                      <td className="px-3 py-2">
                        <Badge variant={tx.txType === "charge" ? "destructive" : "secondary"}>
                          {tx.txType === "charge" ? "Charge" : "Payment"}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{tx.description || "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {tx.txType === "charge" ? <span>${fmt(Number(tx.amount))}</span> : "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {tx.txType === "payment" ? (
                          <span className="text-green-600 dark:text-green-400">${fmt(Number(tx.amount))}</span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td
                        className={`px-3 py-2 text-right tabular-nums font-medium ${tx.runningBalance > 0 ? "text-red-600 dark:text-red-400" : tx.runningBalance < 0 ? "text-green-600 dark:text-green-400" : ""}`}
                      >
                        ${fmt(tx.runningBalance)}
                      </td>
                      <td className="px-3 py-2 print:hidden">
                        {recordChanges.allowed && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() =>
                              wrapAdminAction(
                                () => setPendingDelete(() => () => deleteTx.mutate(tx.id)),
                                "Delete Transaction"
                              )
                            }
                            data-testid={`button-delete-tx-${tx.id}`}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="sticky bottom-0 z-20 bg-background">
                  <tr className="border-t font-semibold bg-muted/20">
                    <td className="px-3 py-2" colSpan={3}>
                      TOTALS
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">${fmt(data.totalCharged)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-green-600 dark:text-green-400">
                      ${fmt(data.totalPaid)}
                    </td>
                    <td
                      className={`px-3 py-2 text-right tabular-nums ${data.outstanding > 0 ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"}`}
                    >
                      ${fmt(data.outstanding)}
                    </td>
                    <td className="print:hidden" />
                  </tr>
                </tfoot>
              </table>
            )}
          </div>
        </div>
      </Card>

      <ChargeDialog transporterId={transporterId} open={chargeOpen} onClose={() => setChargeOpen(false)} />
      <PaymentDialog transporterId={transporterId} open={paymentOpen} onClose={() => setPaymentOpen(false)} />
      <DeleteConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        onConfirm={() => {
          pendingDelete?.();
          setPendingDelete(null);
        }}
      />
      {AdminDialog}
    </div>
  );
}
