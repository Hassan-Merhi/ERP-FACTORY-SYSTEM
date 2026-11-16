import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Loader2, Package, Trash2 } from "lucide-react";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { fmt, fmtKg } from "../utils";

interface WasteDispatchPrintBale {
  id: number;
  referenceNumber: string;
  weightKg: number | string;
  totalCost: number | string;
}

interface WasteDispatchPrintData {
  dispatch: { dispatchNumber: string; dispatchDate: string; notes?: string | null };
  bales: WasteDispatchPrintBale[];
  totalBales: number;
  totalWeightKg: number | string;
  totalCostWrittenOff: number | string;
}

interface WasteDispatchDialogsProps {
  confirming: boolean;
  setConfirming: (open: boolean) => void;
  selectedCount: number;
  totalWeight: number;
  totalCost: number;
  dispatchDate: string;
  notes: string;
  submitPending: boolean;
  onSubmit: () => void;
  deleteDispatchId: number | null;
  setDeleteDispatchId: (id: number | null) => void;
  deletePending: boolean;
  onDelete: (id: number) => void;
  printData: WasteDispatchPrintData | null;
  setPrintData: (data: WasteDispatchPrintData | null) => void;
}

export function WasteDispatchDialogs(props: WasteDispatchDialogsProps) {
  const printRef = useRef<HTMLDivElement>(null);

  const handlePrint = () => {
    if (!printRef.current) return;
    const win = window.open("", "_blank");
    if (!win) return;
    win.document.write(
      `<html><head><title>Waste Disposal — ${props.printData?.dispatch.dispatchNumber ?? ""}</title><style>body{font-family:Arial,sans-serif;font-size:12px;margin:20px}h1{font-size:18px;margin-bottom:4px}.sub{color:#555;font-size:11px;margin-bottom:16px}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{border:1px solid #ccc;padding:6px 8px;text-align:left}th{background:#f3f4f6;font-weight:bold}.footer{margin-top:24px;font-size:10px;color:#777}</style></head><body>${printRef.current.innerHTML}</body></html>`
    );
    win.document.close();
    win.focus();
    win.print();
    win.close();
  };

  return (
    <>
      <Dialog open={props.confirming} onOpenChange={props.setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="w-5 h-5" /> Confirm Waste Disposal
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              You are about to permanently remove the following from stock as waste:
            </p>
            <div className="bg-destructive/5 border border-destructive/20 rounded-md p-3 space-y-1.5">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Bales</span>
                <span className="font-medium">{props.selectedCount}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Total Weight</span>
                <span className="font-medium">{fmtKg(props.totalWeight)} kg</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Cost Written Off</span>
                <span className="font-medium text-destructive">{fmt(props.totalCost)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Date</span>
                <span className="font-medium">{props.dispatchDate}</span>
              </div>
              {props.notes && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Notes</span>
                  <span className="font-medium max-w-xs text-right">{props.notes}</span>
                </div>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              This will remove these bales from inventory and log a waste disposal expense in the factory daybook. This
              action cannot be undone.
            </p>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => props.setConfirming(false)} disabled={props.submitPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={props.onSubmit}
              disabled={props.submitPending}
              data-testid="button-confirm-dispatch"
            >
              {props.submitPending ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" /> Processing...
                </>
              ) : (
                <>
                  <Trash2 className="w-4 h-4 mr-2" /> Confirm Disposal
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={props.deleteDispatchId !== null}
        onOpenChange={(open) => {
          if (!open) props.setDeleteDispatchId(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="w-5 h-5" /> Delete Waste Dispatch?
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will permanently delete the dispatch record and restore all linked bales back to stock. The daybook
            entry will also be removed. This cannot be undone.
          </p>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => props.setDeleteDispatchId(null)} disabled={props.deletePending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={props.deletePending}
              onClick={() => props.deleteDispatchId !== null && props.onDelete(props.deleteDispatchId)}
              data-testid="button-confirm-delete-dispatch"
            >
              {props.deletePending ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" /> Deleting...
                </>
              ) : (
                <>
                  <Trash2 className="w-4 h-4 mr-2" /> Delete &amp; Restore Stock
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {props.printData && (
        <Dialog open onOpenChange={() => props.setPrintData(null)}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Package className="w-5 h-5 text-green-600" /> Disposal Complete —{" "}
                {props.printData.dispatch.dispatchNumber}
              </DialogTitle>
            </DialogHeader>
            <div ref={printRef} className="space-y-3">
              <div>
                <h1 style={{ fontSize: 18, fontWeight: "bold", marginBottom: 4 }}>Waste Disposal Record</h1>
                <p style={{ color: "#555", fontSize: 11, marginBottom: 16 }}>
                  Dispatch No: {props.printData.dispatch.dispatchNumber}&nbsp;|&nbsp;Date:{" "}
                  {props.printData.dispatch.dispatchDate}
                  {props.printData.dispatch.notes && <>&nbsp;|&nbsp;Note: {props.printData.dispatch.notes}</>}
                </p>
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {["Reference", "Weight (kg)", "Cost Written Off"].map((heading, index) => (
                      <th
                        key={heading}
                        style={{
                          border: "1px solid #ccc",
                          padding: "6px 8px",
                          background: "#f3f4f6",
                          textAlign: index === 0 ? "left" : "right",
                          fontWeight: "bold",
                        }}
                      >
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {props.printData.bales.map((bale) => (
                    <tr key={bale.id}>
                      <td style={{ border: "1px solid #ccc", padding: "5px 8px", fontFamily: "monospace" }}>
                        {bale.referenceNumber}
                      </td>
                      <td style={{ border: "1px solid #ccc", padding: "5px 8px", textAlign: "right" }}>
                        {fmtKg(Number(bale.weightKg))}
                      </td>
                      <td style={{ border: "1px solid #ccc", padding: "5px 8px", textAlign: "right" }}>
                        {fmt(Number(bale.totalCost))}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td style={{ border: "1px solid #ccc", padding: "6px 8px", fontWeight: "bold" }}>
                      TOTAL — {props.printData.totalBales} bale(s)
                    </td>
                    <td
                      style={{ border: "1px solid #ccc", padding: "6px 8px", textAlign: "right", fontWeight: "bold" }}
                    >
                      {fmtKg(Number(props.printData.totalWeightKg))}
                    </td>
                    <td
                      style={{
                        border: "1px solid #ccc",
                        padding: "6px 8px",
                        textAlign: "right",
                        fontWeight: "bold",
                        color: "#dc2626",
                      }}
                    >
                      {fmt(Number(props.printData.totalCostWrittenOff))}
                    </td>
                  </tr>
                </tfoot>
              </table>
              <p style={{ marginTop: 24, fontSize: 10, color: "#777" }}>
                This document confirms the waste disposal of factory bales. A daybook expense entry has been created
                automatically.
              </p>
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => props.setPrintData(null)}>
                Close
              </Button>
              <ExportButton kind="print" variant="default" onClick={handlePrint} className="gap-2" />
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
