// Extracted from ./BalesHistory.tsx to keep that module under the source-size cap.
import { Check, ChevronDown, ChevronRight, Pencil, Printer, RefreshCw, Trash2, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { TableBody, TableCell, TableRow } from "@/components/ui/table";
import { formatLabelNum } from "@/lib/labelHtml";
import { StatusBadge } from "@/components/StatusBadge";
import { useBalesHistoryState } from "./useBalesHistoryState";

export function BalesHistoryTableBodySection({
  canChangeExistingRecords,
  editingNameId,
  editingNameValue,
  expandedGroups,
  groupedFiltered,
  handleReprint,
  mhd,
  myAccess,
  nameInputRef,
  saveEditName,
  selectedIds,
  setDeleteConfirm,
  setEditingNameId,
  setEditingNameValue,
  setRepackConfirm,
  setReturnToStockBale,
  setSelectedIds,
  setWeightEditBale,
  startEditName,
  toggleGroup,
  toggleSelect,
  updateStatus,
  wrapAdminAction,
}: Pick<
  ReturnType<typeof useBalesHistoryState>,
  | "canChangeExistingRecords"
  | "editingNameId"
  | "editingNameValue"
  | "expandedGroups"
  | "groupedFiltered"
  | "handleReprint"
  | "mhd"
  | "myAccess"
  | "nameInputRef"
  | "saveEditName"
  | "selectedIds"
  | "setDeleteConfirm"
  | "setEditingNameId"
  | "setEditingNameValue"
  | "setRepackConfirm"
  | "setReturnToStockBale"
  | "setSelectedIds"
  | "setWeightEditBale"
  | "startEditName"
  | "toggleGroup"
  | "toggleSelect"
  | "updateStatus"
  | "wrapAdminAction"
>) {
  return (
    <TableBody>
      {mhd
        .sortRows(groupedFiltered, (group) => group.articleCode)
        .map((group) => {
          const isExpanded = expandedGroups.has(group.key);
          const allGroupSelected = group.rows.every((r) => selectedIds.has(r.bale.id));
          const someGroupSelected = group.rows.some((r) => selectedIds.has(r.bale.id));
          const uniqueStatuses = [...new Set(group.rows.map((r) => r.bale.status as string))];

          return [
            // ── Group summary row ──
            <TableRow key={`group-${group.key}`} className="cursor-pointer" data-testid={`row-group-${group.key}`}>
              <TableCell>
                <Checkbox
                  checked={allGroupSelected}
                  data-state={someGroupSelected && !allGroupSelected ? "indeterminate" : undefined}
                  onCheckedChange={() => {
                    setSelectedIds((prev) => {
                      const next = new Set(prev);
                      if (allGroupSelected) group.rows.forEach((r) => next.delete(r.bale.id));
                      else group.rows.forEach((r) => next.add(r.bale.id));
                      return next;
                    });
                  }}
                  data-testid={`checkbox-group-${group.key}`}
                />
              </TableCell>
              <TableCell className="text-xs text-muted-foreground font-mono">
                <Badge variant="outline" className="text-xs font-mono">
                  {group.rows.length} bale{group.rows.length !== 1 ? "s" : ""}
                </Badge>
              </TableCell>
              <TableCell>
                <button
                  className="flex items-center gap-1.5 text-left font-medium hover:underline"
                  onClick={() => toggleGroup(group.key)}
                  data-testid={`button-toggle-group-${group.key}`}
                >
                  {isExpanded ? (
                    <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                  )}
                  {mhd.nameFor(group.articleCode, group.productName)}
                </button>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">{group.articleCode}</TableCell>
              <TableCell className="text-right font-semibold">{group.totalQty}</TableCell>
              <TableCell className="text-right font-mono font-semibold">
                {formatLabelNum(group.totalWeightKg)}
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {uniqueStatuses.map((s) => (
                    <StatusBadge key={s} status={s} label={s.replace(/_/g, " ")} showIcon={false} className="text-xs" />
                  ))}
                </div>
              </TableCell>
              <TableCell />
              <TableCell />
            </TableRow>,

            // ── Expanded individual bale rows ──
            ...(isExpanded
              ? group.rows.map((row) => {
                  const bale = row.bale;
                  const product = row.product;
                  return (
                    <TableRow key={bale.id} className="bg-background" data-testid={`row-bale-${bale.id}`}>
                      <TableCell className="pl-6">
                        <Checkbox
                          checked={selectedIds.has(bale.id)}
                          onCheckedChange={() => toggleSelect(bale.id)}
                          data-testid={`checkbox-bale-${bale.id}`}
                        />
                      </TableCell>
                      <TableCell className="font-mono text-xs pl-6">
                        {bale.referenceNumber || bale.baleCode || "-"}
                      </TableCell>
                      <TableCell className="pl-8">
                        {editingNameId === bale.id ? (
                          <div className="flex items-center gap-1">
                            <Input
                              ref={nameInputRef}
                              value={editingNameValue}
                              onChange={(e) => setEditingNameValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") saveEditName(bale.id);
                                if (e.key === "Escape") setEditingNameId(null);
                              }}
                              className="h-7 text-xs w-[160px]"
                              data-testid={`input-edit-name-${bale.id}`}
                            />
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => saveEditName(bale.id)}
                              data-testid={`button-save-name-${bale.id}`}
                            >
                              <Check className="h-3 w-3" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => setEditingNameId(null)}
                              data-testid={`button-cancel-name-${bale.id}`}
                            >
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                        ) : (
                          <div
                            className="flex items-center gap-1 group cursor-pointer text-sm text-muted-foreground"
                            onClick={() => {
                              if (canChangeExistingRecords)
                                startEditName(bale.id, product?.name || bale.productName || "");
                            }}
                            data-testid={`text-product-name-${bale.id}`}
                          >
                            <span>
                              {mhd.nameFor(product?.articleCode || "", product?.name || bale.productName || "-")}
                            </span>
                            {canChangeExistingRecords && (
                              <Pencil className="h-3 w-3 text-muted-foreground visible md:invisible md:group-hover:visible touch:visible" />
                            )}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {product?.articleCode || bale.category || "-"}
                      </TableCell>
                      <TableCell className="text-right">{bale.quantity}</TableCell>
                      <TableCell className="text-right font-mono">
                        <button
                          className="group flex items-center gap-1 ml-auto hover:text-foreground"
                          disabled={!canChangeExistingRecords}
                          onClick={(e) => {
                            e.stopPropagation();
                            setWeightEditBale({
                              id: bale.id,
                              referenceNumber: bale.referenceNumber,
                              weightKg: bale.weightKg,
                            });
                          }}
                          title={canChangeExistingRecords ? "Correct weight" : undefined}
                        >
                          {formatLabelNum(bale.weightKg)}
                          {canChangeExistingRecords && (
                            <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-60 shrink-0" />
                          )}
                        </button>
                      </TableCell>
                      <TableCell>
                        <Select
                          value={bale.status}
                          disabled={!canChangeExistingRecords}
                          onValueChange={(val) =>
                            wrapAdminAction(
                              () => updateStatus.mutate({ id: bale.id, status: val }),
                              "Update Bale Status"
                            )
                          }
                        >
                          <SelectTrigger className="w-[140px] h-8 text-xs" data-testid={`select-status-${bale.id}`}>
                            <StatusBadge
                              status={bale.status}
                              label={bale.status.replace(/_/g, " ")}
                              showIcon={false}
                              className="text-xs"
                            />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="PENDING_PRESSING">Pending Pressing</SelectItem>
                            <SelectItem value="LABEL_PRINTED">Label Printed</SelectItem>
                            <SelectItem value="PRESSED">Pressed</SelectItem>
                            <SelectItem value="FINALIZED">Finalized</SelectItem>
                            <SelectItem value="IN_STOCK">In Stock</SelectItem>
                            <SelectItem value="RESERVED">Reserved</SelectItem>
                            <SelectItem value="SOLD">Sold</SelectItem>
                            <SelectItem value="REPACKED">Repacked</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground" data-testid={`text-last-printed-${bale.id}`}>
                        {row.lastPrintedAt ? new Date(row.lastPrintedAt).toLocaleString() : "Never"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          {canChangeExistingRecords &&
                            (bale.status === "RESERVED_FOR_ORDER" ||
                              bale.status === "RESERVED" ||
                              bale.status === "SOLD") && (
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => setReturnToStockBale(row)}
                                title="Return bale to stock"
                                data-testid={`button-return-to-stock-${bale.id}`}
                              >
                                <Undo2 className="h-4 w-4 text-blue-500" />
                              </Button>
                            )}
                          {canChangeExistingRecords && myAccess?.fullAccess && (
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => setRepackConfirm(row)}
                              disabled={bale.status === "REPACKED" || bale.status === "SOLD"}
                              title="Repack bale"
                              data-testid={`button-repack-${bale.id}`}
                            >
                              <RefreshCw className="h-4 w-4" />
                            </Button>
                          )}
                          {canChangeExistingRecords && (
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => handleReprint(row)}
                              data-testid={`button-reprint-${bale.id}`}
                            >
                              <Printer className="h-4 w-4" />
                            </Button>
                          )}
                          {canChangeExistingRecords && myAccess?.fullAccess && (
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => setDeleteConfirm(bale.id)}
                              data-testid={`button-delete-${bale.id}`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              : []),
          ];
        })}
    </TableBody>
  );
}
