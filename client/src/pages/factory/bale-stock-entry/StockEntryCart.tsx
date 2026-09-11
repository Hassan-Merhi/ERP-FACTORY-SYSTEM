import { useCallback } from "react";
import { Trash2, Plus, Minus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  ResponsiveDataList,
  ResponsiveDataListActions,
  ResponsiveDataListEmpty,
  ResponsiveDataListField,
  ResponsiveDataListFields,
  ResponsiveDataListHeader,
  ResponsiveDataListItem,
  ResponsiveDataListTitle,
} from "@/components/ui/responsive-data-list";
import { useIsMobile } from "@/hooks/use-mobile";
import { BaleLogoPickerPopover } from "./BaleLogoPickerPopover";
import type { FactoryBaleProduct } from "@shared/schema";

type StockEntryProduct = FactoryBaleProduct & {
  grade?: string | null;
  categoryName?: string | null;
};

interface CartItem {
  productId: number;
  product: StockEntryProduct;
  qty: number;
  weightPerBaleKg: number;
  finalizedBy: number | null;
  overrideLogoId: number | null;
}

interface WorkerOption {
  id: number;
  fullName?: string | null;
  name?: string | null;
  active?: boolean | null;
}

interface CustomerOption {
  id: number;
  legalName?: string | null;
  active?: boolean | null;
}

export function StockEntryCart({
  cart,
  workers: _workers,
  workerCategoryFilter: _workerCategoryFilter,
  onUpdateQty,
  onSetQty,
  onUpdateWeight,
  onRemoveItem,
  onAssignWorker,
  onSetLogoOverride,
  allCustomers,
  logoPickerOpen,
  onLogoPickerOpenChange,
  filteredWorkers,
}: {
  cart: CartItem[];
  workers: WorkerOption[];
  workerCategoryFilter: string;
  onUpdateQty: (productId: number, delta: number) => void;
  onSetQty: (productId: number, qty: number) => void;
  onUpdateWeight: (productId: number, weight: number) => void;
  onRemoveItem: (productId: number) => void;
  onAssignWorker: (productId: number, workerId: number | null) => void;
  onSetLogoOverride: (productId: number, logoId: number | null) => void;
  allCustomers: CustomerOption[];
  logoPickerOpen: number | null;
  onLogoPickerOpenChange: (productId: number | null) => void;
  filteredWorkers: WorkerOption[];
}) {
  const isMobile = useIsMobile();

  const handleCellKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>, productId: number, col: "qty" | "weight") => {
      const rowIndex = cart.findIndex((i) => i.productId === productId);
      if (rowIndex === -1) return;

      if (e.key === "ArrowDown") {
        const next = cart[rowIndex + 1];
        if (next) {
          e.preventDefault();
          const selector =
            col === "qty"
              ? `[data-testid="input-qty-${next.productId}"]`
              : `[data-testid="input-weight-${next.productId}"]`;
          (document.querySelector(selector) as HTMLInputElement | null)?.focus();
        }
      } else if (e.key === "ArrowUp") {
        const prev = cart[rowIndex - 1];
        if (prev) {
          e.preventDefault();
          const selector =
            col === "qty"
              ? `[data-testid="input-qty-${prev.productId}"]`
              : `[data-testid="input-weight-${prev.productId}"]`;
          (document.querySelector(selector) as HTMLInputElement | null)?.focus();
        }
      } else if (e.key === "ArrowRight" && col === "qty") {
        e.preventDefault();
        (document.querySelector(`[data-testid="input-weight-${productId}"]`) as HTMLInputElement | null)?.focus();
      } else if (e.key === "ArrowLeft" && col === "weight") {
        e.preventDefault();
        (document.querySelector(`[data-testid="input-qty-${productId}"]`) as HTMLInputElement | null)?.focus();
      }
    },
    [cart]
  );

  return (
    <div className="min-w-0 max-w-full" data-factory-stock-entry-cart="true">
      {isMobile ? (
        <div className="md:hidden">
          {cart.length === 0 ? (
            <ResponsiveDataListEmpty>No items added yet. Scan a code or type to search.</ResponsiveDataListEmpty>
          ) : (
            <ResponsiveDataList aria-label="Bales ready for stock entry">
              {cart.map((item) => (
                <ResponsiveDataListItem key={item.productId} data-testid={`card-cart-${item.productId}`}>
                  <ResponsiveDataListHeader>
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                        <span className="text-[10px] font-bold text-primary">{item.product?.grade || "STK"}</span>
                      </div>
                      <div className="min-w-0">
                        <ResponsiveDataListTitle className="text-base">{item.product?.name}</ResponsiveDataListTitle>
                        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
                          <code className="max-w-full break-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                            {item.product?.articleCode || item.product?.code}
                          </code>
                          {item.product?.categoryName && (
                            <Badge variant="outline" className="h-auto max-w-full whitespace-normal py-0.5 text-[10px]">
                              {item.product.categoryName}
                            </Badge>
                          )}
                        </div>
                      </div>
                    </div>
                  </ResponsiveDataListHeader>

                  <ResponsiveDataListFields>
                    <ResponsiveDataListField label="Bale quantity" className="min-[420px]:col-span-2">
                      <div className="grid grid-cols-[2.75rem_minmax(4rem,1fr)_2.75rem] items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="h-11 w-11 rounded-lg"
                          onClick={() => onUpdateQty(item.productId, -1)}
                          aria-label={`Decrease quantity for ${item.product?.name}`}
                          data-testid={`button-qty-minus-${item.productId}-mobile`}
                        >
                          <Minus className="h-4 w-4" />
                        </Button>
                        <Input
                          type="number"
                          inputMode="numeric"
                          min={0}
                          value={item.qty}
                          onChange={(e) => onSetQty(item.productId, parseInt(e.target.value) || 0)}
                          className="h-11 min-w-0 text-center text-base font-bold"
                          aria-label={`Quantity for ${item.product?.name}`}
                          data-testid={`input-qty-${item.productId}-mobile`}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="h-11 w-11 rounded-lg"
                          onClick={() => onUpdateQty(item.productId, 1)}
                          aria-label={`Increase quantity for ${item.product?.name}`}
                          data-testid={`button-qty-plus-${item.productId}-mobile`}
                        >
                          <Plus className="h-4 w-4" />
                        </Button>
                      </div>
                    </ResponsiveDataListField>

                    <ResponsiveDataListField label="Kilograms per bale">
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          step="0.1"
                          value={item.weightPerBaleKg}
                          onChange={(e) => onUpdateWeight(item.productId, parseFloat(e.target.value) || 0)}
                          className="h-11 min-w-0 text-base font-medium"
                          aria-label={`Kilograms per bale for ${item.product?.name}`}
                          data-testid={`input-weight-${item.productId}-mobile`}
                        />
                        <span className="shrink-0 text-xs font-medium uppercase text-muted-foreground">kg</span>
                      </div>
                    </ResponsiveDataListField>

                    <ResponsiveDataListField label="Finalized by">
                      <Select
                        value={item.finalizedBy ? String(item.finalizedBy) : "none"}
                        onValueChange={(val) => onAssignWorker(item.productId, val === "none" ? null : parseInt(val))}
                      >
                        <SelectTrigger
                          className="min-h-11 w-full text-sm"
                          data-testid={`select-worker-${item.productId}-mobile`}
                        >
                          <SelectValue placeholder="Select worker..." />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Unassigned</SelectItem>
                          {filteredWorkers.map((w) => (
                            <SelectItem key={w.id} value={String(w.id)}>
                              {w.fullName || w.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </ResponsiveDataListField>

                    <ResponsiveDataListField label="Customer logo">
                      <div className="flex min-h-11 items-center">
                        <BaleLogoPickerPopover
                          productId={item.productId}
                          overrideLogoId={item.overrideLogoId}
                          allCustomers={allCustomers}
                          onSelect={(logoId) => onSetLogoOverride(item.productId, logoId)}
                          open={logoPickerOpen === item.productId}
                          onOpenChange={(open) => onLogoPickerOpenChange(open ? item.productId : null)}
                        />
                      </div>
                    </ResponsiveDataListField>
                  </ResponsiveDataListFields>

                  <ResponsiveDataListActions className="min-[360px]:grid-cols-1">
                    <Button
                      type="button"
                      variant="outline"
                      className="text-destructive hover:text-destructive"
                      onClick={() => onRemoveItem(item.productId)}
                      data-testid={`button-remove-item-${item.productId}-mobile`}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Remove item
                    </Button>
                  </ResponsiveDataListActions>
                </ResponsiveDataListItem>
              ))}
            </ResponsiveDataList>
          )}
        </div>
      ) : (
        <div className="hidden overflow-hidden rounded-xl border bg-card/50 md:block">
          <Table scrollLabel="Bales ready for stock entry" minimumWidth="56rem">
            <TableHeader>
              <TableRow className="bg-muted/30">
                <TableHead className="w-[40%]">Product</TableHead>
                <TableHead className="w-[15%] text-center">Bale Qty</TableHead>
                <TableHead className="w-[15%] text-right">Kg / Bale</TableHead>
                <TableHead className="w-[20%]">Finalized By</TableHead>
                <TableHead className="w-[10%] text-right"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cart.map((item) => (
                <TableRow
                  key={item.productId}
                  className="transition-colors hover:bg-muted/30"
                  data-testid={`row-cart-${item.productId}`}
                >
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                        <span className="text-[10px] font-bold text-primary">{item.product?.grade || "STK"}</span>
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-bold" data-testid={`text-cart-name-${item.productId}`}>
                          {item.product?.name}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <code className="rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">
                            {item.product?.articleCode || item.product?.code}
                          </code>
                          {item.product?.categoryName && (
                            <Badge variant="outline" className="h-3.5 px-1 py-0 text-[9px] font-medium">
                              {item.product.categoryName}
                            </Badge>
                          )}
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-center gap-1">
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-7 w-7 rounded-md"
                        onClick={() => onUpdateQty(item.productId, -1)}
                        data-testid={`button-qty-minus-${item.productId}`}
                      >
                        <Minus className="h-3 w-3" />
                      </Button>
                      <Input
                        type="number"
                        value={item.qty}
                        onChange={(e) => onSetQty(item.productId, parseInt(e.target.value) || 0)}
                        onKeyDown={(e) => handleCellKeyDown(e, item.productId, "qty")}
                        className="h-7 w-12 p-0 text-center font-bold"
                        data-testid={`input-qty-${item.productId}`}
                      />
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-7 w-7 rounded-md"
                        onClick={() => onUpdateQty(item.productId, 1)}
                        data-testid={`button-qty-plus-${item.productId}`}
                      >
                        <Plus className="h-3 w-3" />
                      </Button>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1.5">
                      <Input
                        type="number"
                        value={item.weightPerBaleKg}
                        onChange={(e) => onUpdateWeight(item.productId, parseFloat(e.target.value) || 0)}
                        onKeyDown={(e) => handleCellKeyDown(e, item.productId, "weight")}
                        className="h-7 w-16 text-right font-medium"
                        step="0.1"
                        data-testid={`input-weight-${item.productId}`}
                      />
                      <span className="text-[10px] font-medium uppercase text-muted-foreground">kg</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Select
                        value={item.finalizedBy ? String(item.finalizedBy) : "none"}
                        onValueChange={(val) => onAssignWorker(item.productId, val === "none" ? null : parseInt(val))}
                      >
                        <SelectTrigger className="h-7 py-0 text-xs" data-testid={`select-worker-${item.productId}`}>
                          <SelectValue placeholder="Select worker..." />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Unassigned</SelectItem>
                          {filteredWorkers.map((w) => (
                            <SelectItem key={w.id} value={String(w.id)}>
                              {w.fullName || w.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <BaleLogoPickerPopover
                        productId={item.productId}
                        overrideLogoId={item.overrideLogoId}
                        allCustomers={allCustomers}
                        onSelect={(logoId) => onSetLogoOverride(item.productId, logoId)}
                        open={logoPickerOpen === item.productId}
                        onOpenChange={(open) => onLogoPickerOpenChange(open ? item.productId : null)}
                      />
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground transition-colors hover:text-destructive"
                      onClick={() => onRemoveItem(item.productId)}
                      data-testid={`button-remove-item-${item.productId}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {cart.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="h-32 text-center text-muted-foreground">
                    No items added yet. Scan a code or type to search.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
