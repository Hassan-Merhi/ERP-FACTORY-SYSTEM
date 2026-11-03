import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChevronDown, ChevronRight, Eye, RotateCcw, Trash2 } from "lucide-react";

import type { ShippingRow } from "../types";
import { fmtDate } from "../utils";

interface DoneContainersSectionProps {
  expanded: boolean;
  onToggleExpanded: () => void;
  done: ShippingRow[];
  doneTotal: number;
  doneTotalPages: number;
  donePage: number;
  onDonePage: (update: (page: number) => number) => void;
  restorePending: boolean;
  onView: (id: number) => void;
  onRestore: (id: number) => void;
  onDelete: (id: number) => void;
}

/** Collapsible "Done / Hidden Containers" list with its own server-side pagination. */
export function DoneContainersSection({
  expanded,
  onToggleExpanded,
  done,
  doneTotal,
  doneTotalPages,
  donePage,
  onDonePage,
  restorePending,
  onView,
  onRestore,
  onDelete,
}: DoneContainersSectionProps) {
  return (
    <div className="shipping-subsection">
      <button
        className="shipping-done-toggle w-full flex items-center justify-between px-4 py-3 text-sm font-medium"
        onClick={onToggleExpanded}
        data-testid="button-toggle-done"
      >
        <span className="flex items-center gap-2">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          Done / Hidden Containers
          <Badge variant="outline" className="text-xs">
            {doneTotal}
          </Badge>
        </span>
        <span className="text-xs">Collapse to keep workspace clean</span>
      </button>

      {expanded &&
        (done.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground">No done containers yet.</div>
        ) : (
          <div>
            <div className="overflow-x-auto">
              <Table mobileLayout="cards" className="text-xs">
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Invoice #</TableHead>
                    <TableHead className="text-xs">Client</TableHead>
                    <TableHead className="text-xs">Container #</TableHead>
                    <TableHead className="text-xs">Destination</TableHead>
                    <TableHead className="text-xs">Done Date</TableHead>
                    <TableHead className="text-xs">WA Sent</TableHead>
                    <TableHead className="text-xs">Done By</TableHead>
                    <TableHead className="w-28" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {done.map((r) => (
                    <TableRow key={r.id} className="opacity-70" data-testid={`row-done-${r.id}`}>
                      <TableCell className="font-mono">{r.invoiceNumber}</TableCell>
                      <TableCell>{r.clientName || "—"}</TableCell>
                      <TableCell className="font-mono">{r.containerNumber || "—"}</TableCell>
                      <TableCell>{r.destination || "—"}</TableCell>
                      <TableCell className="whitespace-nowrap">{fmtDate(r.doneAt)}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        {r.whatsappSentAt ? (
                          <span className="text-green-700 dark:text-green-400">{fmtDate(r.whatsappSentAt)}</span>
                        ) : (
                          <span className="text-muted-foreground italic">—</span>
                        )}
                      </TableCell>
                      <TableCell>{r.doneBy || "—"}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => onView(r.id)}
                            data-testid={`button-view-done-${r.id}`}
                          >
                            <Eye className="h-3.5 w-3.5 mr-1" /> View
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={restorePending}
                            onClick={() => onRestore(r.id)}
                            data-testid={`button-restore-${r.id}`}
                          >
                            <RotateCcw className="h-3.5 w-3.5 mr-1" /> Restore
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => onDelete(r.id)}
                            data-testid={`button-delete-done-${r.id}`}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-destructive" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {doneTotalPages > 1 && (
              <div className="flex items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground">
                <span>
                  Page {donePage} of {doneTotalPages} · {doneTotal} completed containers
                </span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={donePage <= 1}
                    onClick={() => onDonePage((page) => Math.max(1, page - 1))}
                    data-testid="button-done-prev-page"
                  >
                    Previous
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={donePage >= doneTotalPages}
                    onClick={() => onDonePage((page) => Math.min(doneTotalPages, page + 1))}
                    data-testid="button-done-next-page"
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </div>
        ))}
    </div>
  );
}
