import {
  AlertTriangle,
  FileSpreadsheet,
  FileText,
  Loader2,
  Package,
  RefreshCw,
  ShieldCheck,
  Truck,
  Wallet,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { fmtAmount, fmtCount, headerButton, type Props, type Source } from "./FactoryDispatchOrderDashboardTypes";
import {
  FactoryDispatchOrderDashboardSection,
  FactoryDispatchOrderDashboardSection2,
  useFactoryDispatchOrderDashboardState,
} from "./useFactoryDispatchOrderDashboardState";
import { FactoryDispatchOrderDashboardSection3 } from "./FactoryDispatchOrderDashboardSection3";
import { SelectContent, SelectItem, SelectTrigger, SelectValue, Select } from "@/components/ui/select";

export default function FactoryDispatchOrderDashboard(props: Props) {
  const {
    date,
    expanded,
    exportOrderExcel,
    exportingExcel,
    filterTrip,
    filteredTrips,
    gate,
    history,
    historyRows,
    info,
    label,
    onCompareAll,
    onOpenTrip,
    onPhysicalReport,
    orderId,
    search,
    section,
    sectionItems,
    setExpanded,
    setFilterTrip,
    setSearch,
    setSection,
    setSource,
    source,
    value,
  } = useFactoryDispatchOrderDashboardState(props);
  return (
    <Card
      className="overflow-hidden border-slate-200 bg-background shadow-sm dark:border-blue-500/20"
      data-testid="factory-dispatch-order-financial-dashboard"
    >
      <CardContent className="space-y-4 p-4 sm:p-5">
        <FactoryDispatchOrderDashboardSection3
          exportOrderExcel={exportOrderExcel}
          exportingExcel={exportingExcel}
          info={info}
          onCompareAll={onCompareAll}
          onPhysicalReport={onPhysicalReport}
          orderId={orderId}
        />
        {info.isPending && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading order-level financial evidence…
          </p>
        )}
        {info.isError && (
          <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-xs text-red-900 dark:border-red-800 dark:bg-red-950/20 dark:text-red-200">
            <AlertTriangle className="mr-1.5 inline h-4 w-4" />
            {info.error instanceof Error ? info.error.message : "Unable to load order report"}
          </div>
        )}
        {value && (
          <>
            <div className="flex flex-wrap gap-2 text-xs">
              {value.order.customerName && <Badge variant="outline">{value.order.customerName}</Badge>}
              <Badge variant="outline">{value.order.containerNumber ?? "No container number"}</Badge>
              <Badge variant="secondary">{label(value.order.status)}</Badge>
              {value.summary.signed && <Badge variant="outline">Signed reconciliation</Badge>}
              {value.summary.finalized && (
                <Badge variant="outline">Invoice {value.invoice?.invoiceNumber ?? value.order.invoiceNumber}</Badge>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
              {(
                [
                  [
                    "Trucks closed",
                    fmtCount(value.summary.closedTrips) + " / " + fmtCount(value.summary.tripCount),
                    Truck,
                  ],
                  ["Physically scanned", fmtCount(value.summary.uniqueScannedBales) + " bales", Package],
                  [
                    "Posted trip receivable",
                    value.schemaReady ? "$ " + fmtAmount(value.summary.tripCustomerTotal) : "Not installed",
                    Wallet,
                  ],
                  [
                    "One final invoice",
                    value.summary.finalized ? "$ " + fmtAmount(value.summary.invoiceTotal) : "Not finalized",
                    FileText,
                  ],
                ] as const
              ).map(([heading, number, Icon]) => (
                <div key={heading} className="flex min-w-0 gap-2 rounded-xl border border-border bg-muted/30 p-3">
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-300" />
                  <div className="min-w-0">
                    <p className="text-[11px] text-muted-foreground">{heading}</p>
                    <p className="mt-1 break-words font-mono text-sm font-semibold">{number}</p>
                  </div>
                </div>
              ))}
            </div>
            {/* Accounting integrity is checked automatically in the background.
              Healthy/pending checks are not a user task or an operational card. */}
            {(gate.isError ||
              (gate.data &&
                (!gate.data.reconciliation.ready ||
                  !gate.data.invoice.ready ||
                  gate.data.integrity?.passed === false))) && (
              <div
                className="rounded-xl border border-amber-400/50 bg-amber-50/70 p-3 text-xs text-amber-950 dark:border-amber-700 dark:bg-amber-950/20 dark:text-amber-200"
                data-testid="factory-dispatch-accounting-attention"
              >
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div className="space-y-1">
                    <p className="font-semibold">Accounting attention required</p>
                    {gate.isError && (
                      <p>
                        Automatic accounting verification is temporarily unavailable. Posting and invoice guards remain
                        active.
                      </p>
                    )}
                    {gate.data && (!gate.data.reconciliation.ready || !gate.data.invoice.ready) && (
                      <p>
                        Required database accounting protections are not installed. Financial approval remains
                        restricted until the administrator applies the missing migration.
                      </p>
                    )}
                    {gate.data?.integrity && !gate.data.integrity.passed && (
                      <details>
                        <summary className="cursor-pointer font-medium">
                          {gate.data.integrity.checks.filter((check) => check.state === "BLOCK").length} accounting
                          discrepancy(s) detected automatically
                        </summary>
                        <div className="mt-2 max-h-48 space-y-1 overflow-auto">
                          {gate.data.integrity.checks
                            .filter((check) => check.state === "BLOCK")
                            .map((check) => (
                              <p key={check.code}>
                                {check.message}
                                {check.expected !== undefined ? " · Expected: " + check.expected : ""}
                                {check.observed !== undefined ? " · Observed: " + check.observed : ""}
                              </p>
                            ))}
                        </div>
                      </details>
                    )}
                  </div>
                </div>
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted/40 px-3 py-2 text-xs">
              <span className="text-muted-foreground">
                Loaded now: {value.summary.originalLoadingBales} · scanned events: {value.summary.scannedBales} ·
                unshipped: {value.summary.unshippedBales} · unexpected: {value.summary.unexpectedScannedBales}
              </span>
              <span className="font-medium">{value.summary.generatedPoFiles} ERP PO file(s) generated</span>
            </div>
            {value.notices.map((note) => (
              <p
                key={note}
                className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/80 p-2.5 text-xs text-amber-950 dark:border-amber-700/40 dark:bg-amber-950/20 dark:text-amber-100"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                {note}
              </p>
            ))}
            {value.invoice && (
              <div
                className="flex flex-wrap justify-between gap-3 rounded-xl border border-border bg-muted/20 p-3 text-xs"
                data-testid="dispatch-combined-invoice-evidence"
              >
                <div className="space-y-1">
                  <p className="font-semibold">
                    {value.summary.finalized ? "Final consolidated invoice" : "Order-wide reconciliation"}
                    {value.invoice.invoiceNumber ? " · " + value.invoice.invoiceNumber : ""}
                  </p>
                  <p className="text-muted-foreground">
                    Signed: {date(value.invoice.signedAt)}
                    {value.invoice.signedBy ? " · User " + value.invoice.signedBy : ""}
                  </p>
                  <p className="text-muted-foreground">
                    Finalized: {date(value.invoice.finalizedAt)} · Original truck postings:{" "}
                    {value.invoice.includedPostingIds.length} · Final invoice vouchers:{" "}
                    {value.invoice.finalizationVoucherIds.length}
                  </p>
                </div>
                <Badge variant="outline" className="h-fit">
                  {value.summary.finalized
                    ? "One invoice finalized"
                    : value.summary.signed
                      ? "Signed, awaiting invoice"
                      : "Not yet signed"}
                </Badge>
              </div>
            )}
            <div
              className="flex flex-wrap gap-1.5 border-b border-border pb-3"
              role="tablist"
              aria-label="Dispatch order financial reports"
            >
              {sectionItems.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  role="tab"
                  aria-selected={section === item.id}
                  onClick={() => setSection(item.id)}
                  className={
                    "inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors " +
                    headerButton(section === item.id)
                  }
                  data-testid={"dispatch-dashboard-tab-" + item.id.toLowerCase()}
                >
                  <item.icon className="h-4 w-4" />
                  {item.title}
                  {item.count !== undefined && <span className="opacity-75">({item.count})</span>}
                </button>
              ))}
            </div>
            {section === "TRIPS" && (
              <FactoryDispatchOrderDashboardSection2
                date={date}
                filteredTrips={filteredTrips}
                label={label}
                onOpenTrip={onOpenTrip}
                search={search}
                setSearch={setSearch}
              />
            )}
            {section === "CHARGES" && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Billable trip charges and discounts are included in posted trip totals; original loading charges are
                  separate. Internal costs do not increase the customer invoice.
                </p>
                {!value.charges.length && (
                  <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
                    No charges recorded.
                  </p>
                )}
                {value.charges.map((c) => (
                  <div
                    key={c.kind + "-" + c.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3 text-xs"
                  >
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-semibold">{c.name}</p>
                        <Badge variant="outline">{c.kind === "ORDER" ? "Original order" : label(c.kind)}</Badge>
                        <Badge variant="secondary">{label(c.status)}</Badge>
                      </div>
                      <p className="mt-1 text-muted-foreground">
                        {c.dispatchNumber === null ? "Parent loading" : "Trip #" + c.dispatchNumber} ·
                        {c.accountCode
                          ? " " + c.accountCode + " — " + (c.accountName ?? "")
                          : " Ledger account missing"}
                        {c.offsetAccountCode ? " · Offset " + c.offsetAccountCode : ""}
                        {c.postedVoucherId ? " · Voucher #" + c.postedVoucherId : ""}
                      </p>
                    </div>
                    <strong className="font-mono text-sm">
                      {c.kind === "DISCOUNT" ? "− " : ""}$ {fmtAmount(c.amount)}
                    </strong>
                  </div>
                ))}
                <div className="grid grid-cols-2 gap-2 rounded-lg bg-muted/40 p-3 text-xs sm:grid-cols-4">
                  <div>
                    <p className="text-muted-foreground">Trip billable</p>
                    <strong>$ {fmtAmount(value.summary.billableCharges)}</strong>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Trip discounts</p>
                    <strong>$ {fmtAmount(value.summary.discounts)}</strong>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Original order charges</p>
                    <strong>$ {fmtAmount(value.summary.originalOrderCharges)}</strong>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Posted internal expenses</p>
                    <strong>$ {fmtAmount(value.summary.internalExpenses)}</strong>
                  </div>
                </div>
              </div>
            )}
            {section === "PO_FILES" && (
              <div className="space-y-2">
                <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-3 text-xs text-amber-950 dark:border-amber-700/40 dark:bg-amber-950/20 dark:text-amber-100">
                  <AlertTriangle className="mr-1.5 inline h-4 w-4" />
                  Downloading a Factory PO Excel does not import it. Supplier balances are created only when you
                  manually validate and import it in Normal ERP.
                </div>
                {value.trips.map((t) => (
                  <div
                    key={t.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
                  >
                    <div className="min-w-0 space-y-1 text-xs">
                      <p className="font-semibold">
                        Trip #{t.dispatchNumber} · {t.exportedAt ? "File generated" : "File not generated"}
                      </p>
                      <p className="text-muted-foreground">
                        ERP PO: {t.poNumber ?? "—"} · Supplier: {t.supplierCode ?? "—"}
                      </p>
                      <p className="text-muted-foreground">
                        ERP Container: {t.erpContainerNumber ?? "—"} · Generated: {date(t.exportedAt)}
                      </p>
                      <p className="text-amber-700 dark:text-amber-300">
                        Import status: {t.exportedAt ? "Not confirmed by Factory" : "Not exported"}
                      </p>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => onOpenTrip(Number(t.id))}>
                      <FileSpreadsheet className="mr-1.5 h-4 w-4" /> Open PO export
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {section === "HISTORY" && (
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <Select
                    value={source}
                    onValueChange={(v) => {
                      setSource(v as Source);
                      setExpanded(null);
                    }}
                  >
                    <SelectTrigger aria-label="Activity history source" className="h-9 w-auto text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ALL">All activity</SelectItem>
                      <SelectItem value="PHYSICAL">Physical scans & dispatch</SelectItem>
                      <SelectItem value="FINANCIAL">Financial & invoice</SelectItem>
                      <SelectItem value="CLOSURE">Signed truck closures</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select
                    value={filterTrip}
                    onValueChange={(v) => {
                      setFilterTrip(v);
                      setExpanded(null);
                    }}
                  >
                    <SelectTrigger aria-label="Activity history dispatch" className="h-9 w-auto text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ALL">All trucks</SelectItem>
                      {value.trips.map((t) => (
                        <SelectItem key={t.id} value={String(t.id)}>
                          Trip #{t.dispatchNumber}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void history.refetch()}
                    disabled={history.isFetching}
                  >
                    <RefreshCw className={"mr-1.5 h-4 w-4 " + (history.isFetching ? "animate-spin" : "")} /> Refresh
                    history
                  </Button>
                </div>
                {history.isPending && (
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading signed audit history…
                  </p>
                )}
                {history.isError && (
                  <p className="rounded-lg border border-red-300 p-3 text-xs text-destructive">
                    {history.error instanceof Error ? history.error.message : "Unable to read activity history"}
                  </p>
                )}
                {!history.isPending && !historyRows.length && (
                  <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
                    No history events match this filter.
                  </p>
                )}
                <FactoryDispatchOrderDashboardSection
                  date={date}
                  expanded={expanded}
                  historyRows={historyRows}
                  label={label}
                  setExpanded={setExpanded}
                />
                {history.hasNextPage && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void history.fetchNextPage()}
                    disabled={history.isFetchingNextPage}
                    className="w-full"
                  >
                    {history.isFetchingNextPage && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                    Load older events
                  </Button>
                )}
                <p className="text-[11px] text-muted-foreground">
                  Activity is paginated, with original audit events preserved. Excel exports include up to the latest
                  1,000 events and disclose if older history exists.
                </p>
              </div>
            )}
            <p className="flex items-start gap-1.5 border-t border-border pt-3 text-[11px] text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
              Read-only financial reporting. This page does not finalize trucks, add charges, move inventory, bill
              customers or automatically import purchase orders into ERP.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
