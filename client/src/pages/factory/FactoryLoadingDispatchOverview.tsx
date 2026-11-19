import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ClipboardCheck,
  FileCheck2,
  FileText,
  Loader2,
  Package,
  ReceiptText,
  ScanLine,
  ShieldAlert,
  Truck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { companyQueryKey } from "@/lib/companyQueryScope";
import FactoryDispatchOrderDashboard from "./FactoryDispatchOrderDashboard";
import { fmtAmount, json, type Overview, type ReleaseGate } from "./FactoryDispatchOrderDashboardTypes";
import { printNumber, tripPath } from "./FactoryLoadingDispatchTripEditor";
import { FactoryLoadingDispatchSection, useFactoryLoadingDispatchState } from "./useFactoryLoadingDispatchState";

type State = ReturnType<typeof useFactoryLoadingDispatchState>;
type Tab = "trips" | "charges" | "invoice";

export default function FactoryLoadingDispatchOverview({ state }: { state: State }) {
  const [tab, setTab] = useState<Tab>("trips");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const {
    canCreate,
    canViewFinancialDashboard,
    companyId,
    completion,
    filter,
    formatDisplayDateTime,
    loadedQty,
    loadedWeight,
    navigate,
    openTrips,
    orderId,
    remainingQty,
    setCreateOpen,
    setFilter,
    trips,
    tripsQuery,
    verifiedQty,
    verifiedWeight,
    visibleTrips,
  } = state;
  const activeTab: Tab = canViewFinancialDashboard ? tab : "trips";
  const overviewBase = "/api/factory/customer-orders/" + orderId + "/loading-dispatches";
  const finance = useQuery<Overview>({
    queryKey: companyQueryKey(overviewBase + "/order-overview", companyId),
    queryFn: () => json<Overview>(overviewBase + "/order-overview"),
    enabled: canViewFinancialDashboard && activeTab !== "trips" && Boolean(companyId),
    refetchInterval: activeTab === "trips" ? false : 20000,
  });
  const readiness = useQuery<ReleaseGate>({
    queryKey: companyQueryKey(overviewBase + "/release-readiness", companyId),
    queryFn: () => json<ReleaseGate>(overviewBase + "/release-readiness"),
    enabled: canViewFinancialDashboard && activeTab === "invoice" && Boolean(companyId),
  });
  const compare = () => navigate(tripPath(orderId) + "/compare");
  const physicalReport = () => navigate(tripPath(orderId) + "/report");
  const financialProblem =
    readiness.isError ||
    (readiness.data &&
      (!readiness.data.invoice.ready ||
        !readiness.data.reconciliation.ready ||
        readiness.data.integrity?.passed === false));

  const metrics = [
    { label: "Loading bales", count: loadedQty, icon: Package },
    { label: "Scanned on trips", count: verifiedQty, icon: ScanLine },
    { label: "Not yet scanned", count: remainingQty, icon: ClipboardCheck },
    { label: "Open dispatches", count: openTrips, icon: Truck },
  ] as const;

  return (
    <div className="space-y-4" data-testid="dispatch-simplified-overview">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {metrics.map(({ label, count, icon: Icon }) => (
          <div key={label} className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-sm">
            <span className="rounded-xl bg-blue-500/10 p-2.5 text-blue-600 dark:text-blue-300">
              <Icon className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">{label}</p>
              <strong className="font-mono text-2xl font-semibold">{printNumber(count)}</strong>
            </div>
          </div>
        ))}
      </div>

      <Card className="overflow-hidden border-border bg-card shadow-sm">
        <CardContent className="p-0">
          <div className="flex flex-wrap gap-1 border-b border-border px-3 pt-3 sm:px-5" role="tablist" aria-label="Dispatch management sections">
            <button type="button" role="tab" aria-selected={activeTab === "trips"}
              onClick={() => setTab("trips")}
              data-testid="dispatch-simple-tab-trips"
              className={tabClass(activeTab === "trips")}>
              <Truck className="h-4 w-4" /> Trips <span className="text-xs opacity-70">({trips.length})</span>
            </button>
            {canViewFinancialDashboard && (
              <>
                <button type="button" role="tab" aria-selected={activeTab === "charges"}
                  onClick={() => setTab("charges")} data-testid="dispatch-simple-tab-charges"
                  className={tabClass(activeTab === "charges")}>
                  <ReceiptText className="h-4 w-4" /> Charges
                </button>
                <button type="button" role="tab" aria-selected={activeTab === "invoice"}
                  onClick={() => setTab("invoice")} data-testid="dispatch-simple-tab-invoice"
                  className={tabClass(activeTab === "invoice")}>
                  <FileText className="h-4 w-4" /> Final Invoice
                </button>
              </>
            )}
          </div>
          <div className="p-3 sm:p-5">
            {activeTab === "trips" && (
              <FactoryLoadingDispatchSection
                canCreate={canCreate}
                filter={filter}
                formatDisplayDateTime={formatDisplayDateTime}
                navigate={navigate}
                openTrips={openTrips}
                orderId={orderId}
                setCreateOpen={setCreateOpen}
                setFilter={setFilter}
                trips={trips}
                tripsQuery={tripsQuery}
                visibleTrips={visibleTrips}
              />
            )}
            {activeTab !== "trips" && canViewFinancialDashboard && (
              <div role="tabpanel" className="space-y-4">
                {finance.isPending && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading financial details…</p>}
                {finance.isError && <p className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive" role="alert">
                  {finance.error instanceof Error ? finance.error.message : "Unable to load financial details"}
                </p>}
                {finance.data && activeTab === "charges" && (
                  <>
                    <p className="text-sm text-muted-foreground">Charges stay linked to their dispatch. Open a trip to add or change its charges.</p>
                    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                      {([
                        ["Trip billable", finance.data.summary.billableCharges],
                        ["Trip discounts", finance.data.summary.discounts],
                        ["Original loading charges", finance.data.summary.originalOrderCharges],
                        ["Internal costs", finance.data.summary.internalExpenses],
                      ] as const).map(([label, amount]) => (
                        <div key={label} className="rounded-lg border border-border bg-muted/20 p-3">
                          <p className="text-xs text-muted-foreground">{label}</p>
                          <p className="mt-1 font-mono text-base font-semibold">$ {fmtAmount(amount)}</p>
                        </div>
                      ))}
                    </div>
                    {finance.data.charges.length ? (
                      <div className="overflow-x-auto rounded-xl border border-border">
                        <table className="w-full min-w-[560px] text-left text-sm">
                          <thead className="bg-muted/40 text-xs text-muted-foreground"><tr><th className="p-3">Charge</th><th className="p-3">Applies to</th><th className="p-3">Status</th><th className="p-3 text-right">Amount</th></tr></thead>
                          <tbody className="divide-y divide-border">
                            {finance.data.charges.map((charge) => (
                              <tr key={charge.kind + "-" + charge.id}>
                                <td className="p-3"><strong className="font-medium">{charge.name}</strong><p className="text-xs text-muted-foreground">{charge.accountName || charge.accountCode || "No ledger account"}</p></td>
                                <td className="p-3">{charge.dispatchNumber === null ? "Original loading" : "Trip #" + charge.dispatchNumber}</td>
                                <td className="p-3"><Badge variant="outline">{charge.status.toLowerCase()}</Badge></td>
                                <td className="p-3 text-right font-mono">{charge.kind === "DISCOUNT" ? "− " : ""}$ {fmtAmount(charge.amount)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">No charges recorded yet.</p>}
                  </>
                )}
                {finance.data && activeTab === "invoice" && (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-muted/20 p-4">
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">Consolidated invoice</p>
                        <h3 className="text-lg font-semibold">{finance.data.summary.finalized ? finance.data.invoice?.invoiceNumber || finance.data.order.invoiceNumber || "Final invoice" : "Not finalized"}</h3>
                        <p className="text-xs text-muted-foreground">{finance.data.order.customerName || "Customer"} · {finance.data.summary.closedTrips} of {finance.data.summary.tripCount} trips closed</p>
                      </div>
                      <Badge variant={finance.data.summary.finalized ? "secondary" : "outline"}>
                        {finance.data.summary.finalized ? "Finalized" : finance.data.summary.signed ? "Reconciled" : "Awaiting final comparison"}
                      </Badge>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="rounded-xl border border-border p-4"><p className="text-xs text-muted-foreground">Posted trip receivables</p><p className="mt-1 font-mono text-xl font-semibold">{finance.data.schemaReady ? "$ " + fmtAmount(finance.data.summary.tripCustomerTotal) : "Not available"}</p></div>
                      <div className="rounded-xl border border-border p-4"><p className="text-xs text-muted-foreground">Final invoice total</p><p className="mt-1 font-mono text-xl font-semibold">{finance.data.summary.finalized ? "$ " + fmtAmount(finance.data.summary.invoiceTotal) : "Pending finalization"}</p></div>
                    </div>
                    {financialProblem && <p role="alert" className="flex items-start gap-2 rounded-lg border border-amber-400/50 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200"><ShieldAlert className="h-4 w-4 shrink-0" /> Accounting protection or integrity needs attention. Review the detailed records before finalizing.</p>}
                    {finance.data.notices.length > 0 && (
                      <details className="rounded-lg border border-border px-3 py-2 text-xs">
                        <summary className="cursor-pointer">Financial notices ({finance.data.notices.length})</summary>
                        <ul className="mt-2 space-y-1 text-muted-foreground">{finance.data.notices.map((notice, index) => <li key={index}>{notice}</li>)}</ul>
                      </details>
                    )}
                    <Button onClick={compare} variant="default" data-testid="dispatch-open-final-comparison">
                      <FileCheck2 className="mr-2 h-4 w-4" /> {finance.data.summary.finalized ? "View final comparison" : "Review & finalize loading"} <ArrowRight className="ml-2 h-4 w-4" />
                    </Button>
                    <p className="text-xs text-muted-foreground">Finalization takes place on the comparison screen after its required verification checks. This button does not post an invoice.</p>
                  </>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4 shadow-sm">
        <div className="flex min-w-[200px] flex-1 items-center gap-3">
          <span className="rounded-full bg-emerald-500/10 p-2 text-emerald-600"><CheckCircle2 className="h-5 w-5" /></span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold">Overall scan progress</p>
              <span className="font-mono text-sm font-semibold">{completion}%</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Overall scan progress" aria-valuenow={completion} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: completion + "%" }} />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {printNumber(verifiedQty)} scanned / {printNumber(loadedQty)} loading bales · {printNumber(verifiedWeight, 2)} / {printNumber(loadedWeight, 2)} kg
            </p>
          </div>
        </div>
        <Button onClick={compare} variant="outline" data-testid="dispatch-review-verification">
          <ClipboardCheck className="mr-2 h-4 w-4" /> Review final comparison
        </Button>
      </div>

      {canViewFinancialDashboard && (
        <div className="rounded-xl border border-border bg-card">
          <button type="button" onClick={() => setAdvancedOpen(!advancedOpen)}
            aria-expanded={advancedOpen} data-testid="dispatch-toggle-advanced"
            className="flex w-full items-center justify-between gap-2 p-4 text-left text-sm font-medium hover:bg-muted/30">
            <span>Advanced reports, PO exports & activity history</span>
            <ChevronDown className={"h-4 w-4 transition-transform " + (advancedOpen ? "rotate-180" : "")} />
          </button>
          {advancedOpen && (
            <div className="border-t border-border p-3">
              <ErrorBoundary resetKey={"factory-dispatch-overview-" + orderId}>
                <FactoryDispatchOrderDashboard
                  orderId={orderId}
                  companyId={companyId}
                  onOpenTrip={(id) => navigate(tripPath(orderId, id))}
                  onCompareAll={compare}
                  onPhysicalReport={physicalReport}
                />
              </ErrorBoundary>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function tabClass(active: boolean) {
  return "inline-flex items-center gap-2 border-b-2 px-3 py-3 text-sm font-semibold transition-colors " +
    (active ? "border-blue-500 text-blue-600 dark:text-blue-300" : "border-transparent text-muted-foreground hover:text-foreground");
}
