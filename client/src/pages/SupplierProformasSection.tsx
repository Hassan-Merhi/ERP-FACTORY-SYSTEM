// Extracted from ./SupplierProformas.tsx to keep that module under the source-size cap.
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TableCell, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pencil, Save, Star, Trash2, X } from "lucide-react";
import { format } from "date-fns";
import { calculateLineTotal } from "./SupplierProformasTypes";
import { useSupplierProformasState } from "./useSupplierProformasState";

export function SupplierProformasTableRowSection({
  addLineMutation,
  newLine,
  setAddingLine,
  setNewLine,
}: Pick<ReturnType<typeof useSupplierProformasState>, "addLineMutation" | "newLine" | "setAddingLine" | "setNewLine">) {
  return (
    <TableRow>
      <TableCell>
        <Input
          value={newLine.barcode}
          onChange={(e) => setNewLine({ ...newLine, barcode: e.target.value })}
          placeholder="Barcode"
          className="h-8 text-xs"
          data-testid="input-new-barcode"
        />
      </TableCell>
      <TableCell>
        <Input
          value={newLine.itemName}
          onChange={(e) => setNewLine({ ...newLine, itemName: e.target.value })}
          placeholder="Item Name"
          className="h-8 text-xs"
          data-testid="input-new-itemname"
        />
      </TableCell>
      <TableCell>
        <Input
          type="number"
          value={newLine.qty}
          onChange={(e) => setNewLine({ ...newLine, qty: e.target.value })}
          className="h-8 text-xs w-16 text-right"
          data-testid="input-new-qty"
        />
      </TableCell>
      <TableCell>
        <Input
          type="number"
          step="0.01"
          value={newLine.pricePerBale}
          onChange={(e) => setNewLine({ ...newLine, pricePerBale: e.target.value })}
          className="h-8 text-xs w-20 text-right"
          data-testid="input-new-price"
        />
      </TableCell>
      <TableCell className="text-right font-mono">
        {calculateLineTotal(newLine.qty, newLine.pricePerBale).toFixed(2)}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          <Button
            size="icon"
            variant="ghost"
            onClick={() => addLineMutation.mutate(newLine)}
            data-testid="button-save-new-line"
          >
            <Save className="h-3 w-3" />
          </Button>
          <Button size="icon" variant="ghost" onClick={() => setAddingLine(false)} data-testid="button-cancel-new-line">
            <X className="h-3 w-3" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

export function SupplierProformasSection({
  commitRename,
  deleteMutation,
  proformas,
  recordChanges,
  renameInputRef,
  renameValue,
  renamingId,
  selectedProformaId,
  setPendingDelete,
  setRenameValue,
  setRenamingId,
  setSelectedProformaId,
  starMutation,
  startRename,
}: Pick<
  ReturnType<typeof useSupplierProformasState>,
  | "commitRename"
  | "deleteMutation"
  | "proformas"
  | "recordChanges"
  | "renameInputRef"
  | "renameValue"
  | "renamingId"
  | "selectedProformaId"
  | "setPendingDelete"
  | "setRenameValue"
  | "setRenamingId"
  | "setSelectedProformaId"
  | "starMutation"
  | "startRename"
>) {
  return (
    <div>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Proformas</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {(!proformas || proformas.length === 0) && (
            <p className="text-sm text-muted-foreground">No proformas yet. Create one to get started.</p>
          )}
          {proformas?.map((p) => (
            <div
              key={p.id}
              className={`flex items-center justify-between gap-2 p-2 rounded-md cursor-pointer ${selectedProformaId === p.id ? "bg-accent" : "hover-elevate"}`}
              onClick={() => setSelectedProformaId(p.id)}
              data-testid={`row-proforma-${p.id}`}
            >
              <div className="min-w-0 flex-1" onClick={(e) => renamingId === p.id && e.stopPropagation()}>
                {renamingId === p.id ? (
                  <Input
                    ref={renameInputRef}
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => commitRename(p.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitRename(p.id);
                      }
                      if (e.key === "Escape") {
                        e.stopPropagation();
                        setRenamingId(null);
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="h-7 text-sm px-2 py-0"
                    data-testid={`input-rename-proforma-${p.id}`}
                  />
                ) : (
                  <>
                    <div className="flex items-center gap-1.5">
                      {p.isStarred && <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400" />}
                      <span className="text-sm font-medium truncate">{p.reference}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">{format(new Date(p.createdAt), "MMM d, yyyy")}</div>
                  </>
                )}
              </div>
              {recordChanges.allowed && renamingId !== p.id && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={(e) => startRename(e, p)}
                  data-testid={`button-rename-proforma-${p.id}`}
                  title="Rename"
                >
                  <Pencil className="h-3 w-3 text-muted-foreground" />
                </Button>
              )}
              {recordChanges.allowed && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={(e) => {
                    e.stopPropagation();
                    starMutation.mutate(p.id);
                  }}
                  data-testid={`button-star-proforma-${p.id}`}
                  title={p.isStarred ? "Unstar (remove as default)" : "Star (use for auto-comparison)"}
                >
                  <Star
                    className={`h-3.5 w-3.5 ${p.isStarred ? "fill-amber-400 text-amber-400" : "text-muted-foreground"}`}
                  />
                </Button>
              )}
              {recordChanges.allowed && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPendingDelete(() => () => deleteMutation.mutate(p.id));
                  }}
                  data-testid={`button-delete-proforma-${p.id}`}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
