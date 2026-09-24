import { searchAny } from "@shared/searchNormalization";
import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/PageHeader";
import { useAppMode } from "@/contexts/AppModeContext";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AlertTriangle, ClipboardList, Search, Trash2 } from "lucide-react";
import { format } from "date-fns";

const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtMoney = (v: string | number | null | undefined) => {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
};

function currencySymbol(currency: string): string {
  if (currency === "EUR") return "€";
  if (currency === "CFA" || currency === "XAF" || currency === "XOF") return "FC ";
  return "$";
}

function fmtMoneyWithCurrency(v: string | number | null | undefined, currency = "USD"): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  const isCFA = currency === "CFA" || currency === "XAF" || currency === "XOF";
  const formatted = n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: isCFA ? 0 : 2,
  });
  return `${currencySymbol(currency)}${formatted}`;
}

type PaymentRow = {
  id: number;
  paymentDate: string;
  amount: string;
  forYear: number;
  forMonth: number;
  notes: string | null;
  contractId: number;
  unitId: number;
  currency?: string;
  cashAccountId: number | null;
  voucherId: number | null;
  tenantName: string | null;
  unitNumber: string | null;
  locationGroup: string | null;
};

interface Props {
  pageTitle: string;
  pageIcon?: React.ReactNode;
  testIdPrefix: string;
  apiBase?: string;
}

export default function RentalPaymentsLog({
  pageTitle,
  pageIcon,
  testIdPrefix,
  apiBase = "/api/properties/rental",
}: Props) {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const isErp = useAppMode() === "erp";
  const [search, setSearch] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<PaymentRow | null>(null);

  const queryKey = [apiBase + "/payments", selectedCompany?.id];

  const { data: payments = [], isLoading } = useQuery<PaymentRow[]>({
    queryKey,
    queryFn: async () => {
      const res = await fetch(`${apiBase}/payments`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load payments");
      return res.json();
    },
    enabled: !!selectedCompany,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `${apiBase}/payments/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      toast({ title: "Payment deleted", description: "The payment and its accounting entry have been removed." });
      setDeleteTarget(null);
    },
    onError: (e: ClientErrorLike) => {
      toast({ title: "Delete failed", description: e.message, variant: "destructive" });
      setDeleteTarget(null);
    },
  });

  const filtered = useMemo(() => {
    if (!search.trim()) return payments;
    return payments.filter((p) => searchAny(search, p.tenantName, p.unitNumber, p.locationGroup, p.notes));
  }, [payments, search]);

  const total = filtered.reduce((s, p) => s + Number(p.amount), 0);

  return (
    <div className={isErp ? "space-y-4 sm:p-4" : "p-4 space-y-4"} data-testid={`page-${testIdPrefix}-payments-log`}>
      {isErp ? (
        <>
          <PageHeader
            title={pageTitle}
            subtitle="All payment receipts recorded across all units, sorted by date."
            icon={pageIcon ?? <ClipboardList className="h-5 w-5" />}
          />
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Search tenant, unit, notes…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid={`input-${testIdPrefix}-payments-search`}
            />
          </div>
        </>
      ) : (
        <div className="flex items-center gap-3 flex-wrap justify-between">
          <div className="flex items-center gap-3">
            {pageIcon ?? <ClipboardList className="h-7 w-7 text-indigo-600" />}
            <div>
              <PageHeader
                title={pageTitle}
                subtitle="All payment receipts recorded across all units, sorted by date."
              />
            </div>
          </div>
          <div className="relative w-64">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Search tenant, unit, notes…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid={`input-${testIdPrefix}-payments-search`}
            />
          </div>
        </div>
      )}

      {/* Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground font-normal">TOTAL PAYMENTS</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid={`stat-${testIdPrefix}-total-payments`}>
              {filtered.length}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground font-normal">TOTAL AMOUNT RECEIVED</CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className="text-2xl font-bold text-green-600 dark:text-green-400"
              data-testid={`stat-${testIdPrefix}-total-amount`}
            >
              {fmtMoney(total)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground font-normal">UNIQUE TENANTS</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{new Set(filtered.map((p) => p.tenantName).filter(Boolean)).size}</div>
          </CardContent>
        </Card>
      </div>

      {/* Payments table */}
      <Card>
        <CardContent className="p-0">
          <div className="table-responsive">
            {isLoading ? (
              <div className="p-8 text-center text-muted-foreground">Loading payments…</div>
            ) : filtered.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground">
                {payments.length === 0 ? "No payments recorded yet." : "No payments match your search."}
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-30 bg-muted/50 border-b">
                  <tr>
                    <th className="text-left px-3 py-2 font-semibold">Date</th>
                    <th className="text-left px-3 py-2 font-semibold">Client Name</th>
                    <th className="text-left px-3 py-2 font-semibold">Unit</th>
                    <th className="text-right px-3 py-2 font-semibold">Amount</th>
                    <th className="text-left px-3 py-2 font-semibold">For Month</th>
                    <th className="text-left px-3 py-2 font-semibold">Notes</th>
                    <th className="text-left px-3 py-2 font-semibold">Daybook</th>
                    <th className="w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((p, i) => (
                    <tr
                      key={p.id}
                      className={`border-t ${i % 2 === 1 ? "bg-muted/20" : ""}`}
                      data-testid={`row-payment-${p.id}`}
                    >
                      <td className="px-3 py-2 tabular-nums text-sm">
                        {format(new Date(p.paymentDate), "dd MMM yyyy")}
                      </td>
                      <td className="px-3 py-2 font-medium">{p.tenantName ?? "—"}</td>
                      <td className="px-3 py-2">
                        <span className="font-mono text-xs">{p.unitNumber ?? "—"}</span>
                        {p.locationGroup && (
                          <Badge variant="outline" className="ml-1.5 text-xs">
                            {p.locationGroup}
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold text-green-700 dark:text-green-400">
                        {fmtMoneyWithCurrency(p.amount, p.currency)}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {MONTH_NAMES[p.forMonth]} {p.forYear}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{p.notes ?? ""}</td>
                      <td className="px-3 py-2">
                        {p.voucherId ? (
                          <span className="text-xs text-muted-foreground font-mono">#{p.voucherId}</span>
                        ) : (
                          <span
                            className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400"
                            title="No accounting entry — payment was recorded without a cash account"
                          >
                            <AlertTriangle className="h-3 w-3" />
                            No entry
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1 text-right">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setDeleteTarget(p)}
                          data-testid={`button-delete-payment-${p.id}`}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="sticky bottom-0 z-20 border-t-2 bg-muted/30">
                  <tr>
                    <td className="px-3 py-2 font-semibold" colSpan={3}>
                      TOTAL
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-bold text-green-700 dark:text-green-400">
                      {fmtMoney(total)}
                    </td>
                    <td colSpan={4}></td>
                  </tr>
                </tfoot>
              </table>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Delete confirmation */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this payment?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget && (
                <>
                  This will permanently remove the{" "}
                  <strong>{fmtMoneyWithCurrency(deleteTarget.amount, deleteTarget.currency)}</strong> payment from{" "}
                  <strong>{deleteTarget.tenantName ?? "—"}</strong> ({MONTH_NAMES[deleteTarget.forMonth]}{" "}
                  {deleteTarget.forYear}). The accounting entry will be reversed, and any inter-company transfer that
                  was automatically created for this payment will also be fully reversed in both companies. This cannot
                  be undone.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              data-testid="button-confirm-delete-payment"
            >
              {deleteMutation.isPending ? "Deleting…" : "Yes, Delete Payment"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
