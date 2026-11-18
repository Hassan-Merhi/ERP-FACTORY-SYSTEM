// Extracted from ./FactoryShippingContainers.tsx
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MessageCircle, Trash2, Check, CheckCircle2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  INV_LEFT,
  fmtDate,
  statusColor,
  statusLabel,
  stickyCellBase,
  stickyHeadBase,
  shippingCostUsd,
} from "./factoryshippingcontainers/utils";
import { DocIndicator } from "./factoryshippingcontainers/components/DocIndicator";
import { EditableCellInput } from "./factoryshippingcontainers/components/EditableCellInput";
import { DateCellInput } from "./factoryshippingcontainers/components/DateCellInput";
import type { FactoryShippingContainersModel } from "./FactoryShippingContainersModel";

export function FactoryShippingContainersTable({ m }: { m: FactoryShippingContainersModel }) {
  return (
    <Table
      mobileLayout="cards"
      className="text-xs [&_td]:px-2.5 [&_td]:py-1.5 [&_th]:h-9 [&_th]:px-2.5 [&_th]:py-1.5"
      wrapperClassName="overflow-x-auto"
      style={{ minWidth: "1100px" }}
    >
      <TableHeader className="sticky top-0 z-20">
        <TableRow className="bg-slate-100/90 hover:bg-slate-100/90 dark:bg-muted dark:hover:bg-muted">
          {m.colVis.orderDate && <TableHead className="text-xs w-20 min-w-[80px]">Order Date</TableHead>}
          {m.colVis.invoiceNumber && (
            <TableHead
              className={cn(stickyHeadBase, "shipping-sticky")}
              style={{ left: INV_LEFT, minWidth: "130px", width: "130px" }}
            >
              Invoice #
            </TableHead>
          )}
          {m.colVis.clientName && (
            <TableHead
              className={cn(stickyHeadBase, "shipping-sticky")}
              style={{ left: m.clientLeft, minWidth: "144px", width: "144px" }}
            >
              Client
            </TableHead>
          )}
          {m.colVis.status && <TableHead className="text-xs w-24 min-w-[96px]">Status</TableHead>}
          {m.colVis.containerNumber && (
            <TableHead
              className={cn(stickyHeadBase, "shipping-sticky")}
              style={{ left: m.containerLeft, minWidth: "120px", width: "120px" }}
            >
              Container #
            </TableHead>
          )}
          {m.colVis.destination && <TableHead className="text-xs min-w-[120px]">Destination</TableHead>}
          {m.colVis.eta && <TableHead className="text-xs min-w-[100px]">ETA</TableHead>}
          {m.colVis.arrived && <TableHead className="text-xs min-w-[90px]">Arrived</TableHead>}
          {m.colVis.finalized && <TableHead className="text-xs min-w-[90px]">Finalized</TableHead>}
          {m.colVis.shippingCo && <TableHead className="text-xs min-w-[110px]">Shipping Co.</TableHead>}
          {m.colVis.documents && <TableHead className="text-xs min-w-[90px]">Documents</TableHead>}
          {m.colVis.containerCost && <TableHead className="text-xs min-w-[100px]">Container Cost</TableHead>}
          {m.colVis.ciNumber && <TableHead className="text-xs min-w-[100px]">CI No.</TableHead>}
          {m.colVis.note && <TableHead className="text-xs min-w-[110px]">Note</TableHead>}
          {m.colVis.anything && <TableHead className="text-xs min-w-[150px]">Anything</TableHead>}
          {m.colVis.whatsapp && <TableHead className="text-xs min-w-[90px]">WhatsApp</TableHead>}
          {m.colVis.done && <TableHead className="text-xs min-w-[80px]">Done</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {m.isLoading ? (
          <TableRow>
            <TableCell colSpan={18} className="text-center py-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mx-auto" />
            </TableCell>
          </TableRow>
        ) : m.filtered.length === 0 ? (
          <TableRow>
            <TableCell colSpan={18} className="text-center py-10 text-muted-foreground">
              {m.allDisplayRows.length === 0 ? "No active records." : "No records match the current filters."}
            </TableCell>
          </TableRow>
        ) : (
          m.visibleRows.map((r) => (
            <TableRow
              key={r.id}
              className="border-border/40 hover:bg-blue-500/[0.035] dark:hover:bg-blue-400/[0.055]"
              data-testid={`row-record-${r.id}`}
            >
              {m.colVis.orderDate && (
                <TableCell className="text-xs whitespace-nowrap">{fmtDate(r.orderDate)}</TableCell>
              )}

              {/* Sticky: Invoice # */}
              {m.colVis.invoiceNumber && (
                <TableCell className={cn(stickyCellBase, "shipping-sticky")} style={{ left: INV_LEFT }}>
                  <span className="font-mono font-medium text-xs whitespace-nowrap">{r.invoiceNumber}</span>
                </TableCell>
              )}

              {/* Sticky: Client */}
              {m.colVis.clientName && (
                <TableCell
                  className={cn(stickyCellBase, "shipping-sticky font-medium text-xs max-w-[144px] truncate")}
                  style={{ left: m.clientLeft }}
                  title={r.clientName || ""}
                >
                  {r.clientName || "—"}
                </TableCell>
              )}

              {m.colVis.status && (
                <TableCell>
                  <button
                    className="focus:outline-hidden"
                    title="Open order"
                    onClick={() => {
                      if (!r.customerOrderId) return;
                      if (r.status === "FINALIZED") {
                        m.navigate(`/factory/sales/invoices/${r.customerOrderId}`);
                      } else {
                        m.navigate(`/factory/sales/pending-invoices/${r.customerOrderId}/verify`);
                      }
                    }}
                    data-testid={`button-status-${r.id}`}
                  >
                    <Badge className={cn("shipping-status whitespace-nowrap cursor-pointer", statusColor(r.status))}>
                      {statusLabel(r.status)}
                    </Badge>
                  </button>
                </TableCell>
              )}

              {/* Sticky: Container # */}
              {m.colVis.containerNumber && (
                <TableCell className={cn(stickyCellBase, "shipping-sticky")} style={{ left: m.containerLeft }}>
                  <EditableCellInput
                    value={r.containerNumber || ""}
                    placeholder="Enter #"
                    onSave={(v) => m.syncOrderMutation.mutate({ id: r.id, patch: { containerNumber: v || null } })}
                    testId={`cell-container-${r.id}`}
                    saving={m.syncOrderMutation.isPending}
                  />
                </TableCell>
              )}

              {m.colVis.destination && (
                <TableCell>
                  <EditableCellInput
                    value={r.destination || ""}
                    placeholder="Enter destination"
                    onSave={(v) => m.syncOrderMutation.mutate({ id: r.id, patch: { destination: v || null } })}
                    testId={`cell-destination-${r.id}`}
                  />
                </TableCell>
              )}

              {m.colVis.eta && (
                <TableCell>
                  {r._trackedEta ? (
                    <span
                      className="text-xs text-blue-600 dark:text-blue-400 font-medium whitespace-nowrap"
                      title="Auto from tracking"
                    >
                      {fmtDate(r._trackedEta)}
                    </span>
                  ) : (
                    <DateCellInput
                      value={r.eta || ""}
                      placeholder="Set ETA"
                      onSave={(v) => m.patchRowMutation.mutate({ id: r.id, patch: { eta: v || null } })}
                      testId={`cell-eta-${r.id}`}
                    />
                  )}
                </TableCell>
              )}

              {m.colVis.arrived && (
                <TableCell>
                  <DateCellInput
                    value={r.containerArrivedDate || ""}
                    placeholder="Not arrived"
                    onSave={(v) => m.patchRowMutation.mutate({ id: r.id, patch: { containerArrivedDate: v || null } })}
                    testId={`cell-arrived-${r.id}`}
                  />
                </TableCell>
              )}

              {m.colVis.finalized && (
                <TableCell className="whitespace-nowrap">
                  {r.finalizedDate ? (
                    <span className="shipping-date shipping-date-complete">
                      <CheckCircle2 className="mr-1 h-3 w-3" /> {fmtDate(r.finalizedDate)}
                    </span>
                  ) : (
                    <span className="shipping-date shipping-date-pending">Not finalized</span>
                  )}
                </TableCell>
              )}

              {m.colVis.shippingCo && (
                <TableCell>
                  <EditableCellInput
                    value={r.shippingCompany || ""}
                    placeholder="Enter company"
                    onSave={(v) => m.syncOrderMutation.mutate({ id: r.id, patch: { shippingCompany: v || null } })}
                    testId={`cell-shipping-${r.id}`}
                  />
                </TableCell>
              )}

              {m.colVis.documents && (
                <TableCell>
                  <DocIndicator count={r.documentCount} onClick={() => m.setDocsRowId(r.id)} />
                </TableCell>
              )}

              {m.colVis.containerCost && (
                <TableCell className="text-xs whitespace-nowrap font-medium">
                  {r.grandTotal ? (
                    <span className="shipping-cost">{shippingCostUsd(r.grandTotal)}</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
              )}

              {m.colVis.ciNumber && (
                <TableCell>
                  <EditableCellInput
                    value={r.ciNumber || ""}
                    placeholder="Enter CI #"
                    onSave={(v) => m.patchRowMutation.mutate({ id: r.id, patch: { ciNumber: v || null } })}
                    testId={`cell-ci-${r.id}`}
                  />
                </TableCell>
              )}

              {m.colVis.note && (
                <TableCell>
                  <EditableCellInput
                    value={r.note || ""}
                    placeholder="Add note"
                    onSave={(v) => m.patchRowMutation.mutate({ id: r.id, patch: { note: v || null } })}
                    testId={`cell-note-${r.id}`}
                  />
                </TableCell>
              )}

              {m.colVis.anything && (
                <TableCell>
                  <EditableCellInput
                    value={r.anything || ""}
                    placeholder="Type anything"
                    onSave={(v) => m.patchRowMutation.mutate({ id: r.id, patch: { anything: v || null } })}
                    testId={`cell-anything-${r.id}`}
                  />
                </TableCell>
              )}

              {m.colVis.whatsapp && (
                <TableCell>
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-green-300 text-green-700 dark:border-green-700 dark:text-green-400 whitespace-nowrap"
                    onClick={() => m.setWaRowId(r.id)}
                    data-testid={`button-prepare-wa-${r.id}`}
                  >
                    <MessageCircle className="h-3.5 w-3.5 mr-1" /> Prepare
                  </Button>
                </TableCell>
              )}

              {m.colVis.done && (
                <TableCell>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => m.setPendingDoneId(r.id)}
                      data-testid={`button-mark-done-${r.id}`}
                    >
                      <Check className="h-3.5 w-3.5 mr-1" /> Done
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => m.setPendingDeleteId(r.id)}
                      data-testid={`button-delete-row-${r.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                </TableCell>
              )}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
