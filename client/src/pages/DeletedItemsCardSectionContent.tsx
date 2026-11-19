// Extracted from ./DeletedItemsCardSection.tsx
import { format } from "date-fns";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Eye, Package, RotateCcw, Trash2 } from "lucide-react";
import { typeIcons, typeLabels, useDeletedItemsState } from "./useDeletedItemsState";
import { formatUsd } from "@/lib/moneyDisplay";

export function DeletedItemsCardSectionContent({
  formatDisplayDate,
  handlePermanentDelete,
  handleRestore,
  itemKey,
  items,
  permanentDeleteMutation,
  restoreMutation,
  selectedItems,
  setDetailItem,
  toggleAll,
  toggleItem,
}: Pick<
  Pick<
    ReturnType<typeof useDeletedItemsState>,
    | "data"
    | "filterType"
    | "formatDisplayDate"
    | "handlePermanentDelete"
    | "handleRestore"
    | "itemKey"
    | "items"
    | "permanentDeleteMutation"
    | "restoreMutation"
    | "selectedItems"
    | "setDetailItem"
    | "setFilterType"
    | "setSelectedItems"
    | "setShowBulkDeleteDialog"
    | "toggleAll"
    | "toggleItem"
  >,
  | "formatDisplayDate"
  | "handlePermanentDelete"
  | "handleRestore"
  | "itemKey"
  | "items"
  | "permanentDeleteMutation"
  | "restoreMutation"
  | "selectedItems"
  | "setDetailItem"
  | "toggleAll"
  | "toggleItem"
>) {
  return (
    <>
      <div className="hidden md:block phone-land:hidden">
        <Table>
          <TableHeader className="sticky top-0 z-30 bg-background">
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  checked={items.length > 0 && items.every((item) => selectedItems.has(itemKey(item)))}
                  onCheckedChange={() => toggleAll(items)}
                  data-testid="checkbox-select-all"
                />
              </TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Deleted At</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => {
              const IconComponent = typeIcons[item.type] || Package;
              return (
                <TableRow
                  key={`${item.type}-${item.id}`}
                  data-testid={`row-deleted-${item.type}-${item.id}`}
                  className="cursor-pointer hover-elevate"
                  onClick={() => setDetailItem(item)}
                >
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selectedItems.has(itemKey(item))}
                      onCheckedChange={() => toggleItem(item)}
                      data-testid={`checkbox-item-${item.type}-${item.id}`}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <IconComponent className="h-4 w-4 text-muted-foreground" />
                      <Badge variant="outline">{typeLabels[item.type] || item.type}</Badge>
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-sm">{item.code || "-"}</TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <span>{item.name}</span>
                      {item.accountType && <span className="text-xs text-muted-foreground">{item.accountType}</span>}
                      {item.type === "orphanedPosSale" && (
                        <span className="text-xs text-muted-foreground">
                          {item.locationName} | {formatUsd(item.amount ?? 0, 0, 3)}
                        </span>
                      )}
                      {item.type === "voucher" && (
                        <span className="text-xs text-muted-foreground">
                          {item.voucherType} | {formatUsd(item.amount ?? 0, 0, 3)}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    {item.deletedAt
                      ? `${formatDisplayDate(item.deletedAt)} ${format(new Date(item.deletedAt), "h:mm a")}`
                      : "-"}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDetailItem(item);
                        }}
                        data-testid={`button-view-${item.type}-${item.id}`}
                        data-remote-control-safe="true"
                        data-remote-control-action="view-details"
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      {item.type !== "orphanedPosSale" && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRestore(item);
                          }}
                          disabled={restoreMutation.isPending || permanentDeleteMutation.isPending}
                          data-testid={`button-restore-${item.type}-${item.id}`}
                        >
                          <RotateCcw className="h-4 w-4 mr-1" />
                          Restore
                        </Button>
                      )}
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          handlePermanentDelete(item);
                        }}
                        disabled={restoreMutation.isPending || permanentDeleteMutation.isPending}
                        data-testid={`button-delete-permanent-${item.type}-${item.id}`}
                      >
                        <Trash2 className="h-4 w-4 mr-1" />
                        Delete Forever
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <div className="md:hidden phone-land:block space-y-3">
        {items.map((item) => {
          const IconComponent = typeIcons[item.type] || Package;
          return (
            <Card
              key={`${item.type}-${item.id}`}
              className="p-4 cursor-pointer hover-elevate"
              onClick={() => setDetailItem(item)}
              data-testid={`card-deleted-${item.type}-${item.id}`}
            >
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="flex items-center gap-2">
                  <div onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selectedItems.has(itemKey(item))}
                      onCheckedChange={() => toggleItem(item)}
                      data-testid={`checkbox-card-${item.type}-${item.id}`}
                    />
                  </div>
                  <IconComponent className="h-4 w-4 text-muted-foreground" />
                  <Badge variant="outline">{typeLabels[item.type] || item.type}</Badge>
                </div>
                <span className="font-mono text-xs text-muted-foreground">{item.code || "-"}</span>
              </div>
              <p className="font-medium text-sm">{item.name}</p>
              {item.accountType && <p className="text-xs text-muted-foreground">{item.accountType}</p>}
              <p className="text-xs text-muted-foreground mt-1">
                {item.deletedAt
                  ? `${formatDisplayDate(item.deletedAt)} ${format(new Date(item.deletedAt), "h:mm a")}`
                  : "-"}
              </p>
              <div className="flex flex-wrap gap-2 mt-3">
                {item.type !== "orphanedPosSale" && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRestore(item);
                    }}
                    disabled={restoreMutation.isPending || permanentDeleteMutation.isPending}
                  >
                    <RotateCcw className="h-4 w-4 mr-1" />
                    Restore
                  </Button>
                )}
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    handlePermanentDelete(item);
                  }}
                  disabled={restoreMutation.isPending || permanentDeleteMutation.isPending}
                >
                  <Trash2 className="h-4 w-4 mr-1" />
                  Delete
                </Button>
              </div>
            </Card>
          );
        })}
      </div>
    </>
  );
}
