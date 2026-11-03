import type { Dispatch, SetStateAction } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
import { ChevronDown, ChevronRight, Eye, RotateCcw, Trash2 } from "lucide-react";
import type { ShippingRow } from "../types";
import { fmtDate } from "../utils";

interface DoneSectionProps {
  doneExpanded: boolean;
  setDoneExpanded: Dispatch<SetStateAction<boolean>>;
  done: ShippingRow[];
  doneTotal: number;
  doneTotalPages: number;
  donePage: number;
  setDonePage: Dispatch<SetStateAction<number>>;
  restorePending: boolean;
  onView: (id: number) => void;
  onRestore: (id: number) => void;
  onAskDelete: (id: number) => void;
}

/** Completed shipments are kept separate from the active shipping workspace. */
export function ShippingDoneSection({
  doneExpanded, setDoneExpanded, done, doneTotal, doneTotalPages, donePage, setDonePage,
  restorePending, onView, onRestore, onAskDelete,
}: DoneSectionProps) {
  return (
        {/* ── Done / Hidden Containers ── */}
        <div className="shipping-subsection">
          <button
            className="shipping-done-toggle w-full flex items-center justify-between px-4 py-3 text-sm font-medium"
            onClick={() => setDoneExpanded((v) => !v)}
            data-testid="button-toggle-done"
          >
            <span className="flex items-center gap-2">
              {doneExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              Done / Hidden Containers
              <Badge variant="outline" className="text-xs">
                {doneTotal}
              </Badge>
            </span>
            <span className="text-xs">Collapse to keep workspace clean</span>
          </button>

          {doneExpanded &&
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
                                onClick={() => onAskDelete(r.id)}
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
                        onClick={() => setDonePage((page) => Math.max(1, page - 1))}
                        data-testid="button-done-prev-page"
                      >
                        Previous
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={donePage >= doneTotalPages}
                        onClick={() => setDonePage((page) => Math.min(doneTotalPages, page + 1))}
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

interface ConfirmationsProps {
  pendingDeleteId: number | null;
  setPendingDeleteId: Dispatch<SetStateAction<number | null>>;
  pendingDoneId: number | null;
  setPendingDoneId: Dispatch<SetStateAction<number | null>>;
  onDelete: (id: number) => void;
  onDone: (id: number) => void;
}

/** Confirmation dialogs keep the original guarded delete/done actions. */
export function ShippingRecordConfirmations({
  pendingDeleteId, setPendingDeleteId, pendingDoneId, setPendingDoneId, onDelete, onDone,
}: ConfirmationsProps) {
  return (
    <>
      {/* Confirm delete */}
      <AlertDialog
        open={!!pendingDeleteId}
        onOpenChange={(v) => {
          if (!v) setPendingDeleteId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this record?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the shipping container record and all its attached documents. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground"
              onClick={() => {
                if (pendingDeleteId) {
                  onDelete(pendingDeleteId);
                  setPendingDeleteId(null);
                }
              }}
              data-testid="button-confirm-delete-row"
            >
              Yes, Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirm before marking done */}
      <AlertDialog
        open={!!pendingDoneId}
        onOpenChange={(v) => {
          if (!v) setPendingDoneId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark as Done?</AlertDialogTitle>
            <AlertDialogDescription>
              This will move the shipment to the Done / Hidden section. You can restore it later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDoneId) {
                  onDone(pendingDoneId);
                  setPendingDoneId(null);
                }
              }}
              data-testid="button-confirm-done"
            >
              Yes, Mark as Done
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
