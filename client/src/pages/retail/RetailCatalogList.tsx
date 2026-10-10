import { Archive, ArchiveRestore, ArrowRightLeft, History, Pencil, Printer, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent } from "@/components/ui/card";
import { normalizeRetailImageUrls } from "@/lib/retailImageUrl";
import { cn } from "@/lib/utils";
import { ProductImageGallery, RetailImage } from "./RetailProductImage";
import { money, sortRetailVariants, type RetailProduct, type RetailVariant } from "./retailInventoryTypes";

export type RetailVariantAction = "print" | "transfer" | "adjust" | "history" | "archive" | "restore";

export interface RetailCatalogFilters {
  color: string;
  size: string;
  locationId: string;
  stockStatus: string;
  showArchived: boolean;
}

const norm = (value: string) => value.trim().toLowerCase();

/** Quantity that matters for the current view: at the filtered location, or across all locations. */
export function variantQuantity(variant: RetailVariant, locationId: string): number {
  if (!locationId) return variant.quantity;
  return variant.stocks.find((stock) => stock.locationId === Number(locationId))?.quantity ?? 0;
}

/** Variant rows that match the active filters (a style may match while only some sizes do). */
export function visibleVariants(product: RetailProduct, filters: RetailCatalogFilters): RetailVariant[] {
  return sortRetailVariants(
    product.variants.filter((variant) => {
      if (!filters.showArchived && (!variant.active || !product.active)) return false;
      if (filters.color && norm(variant.color) !== norm(filters.color)) return false;
      if (filters.size && norm(variant.size) !== norm(filters.size)) return false;
      const quantity = variantQuantity(variant, filters.locationId);
      if (filters.stockStatus === "in" && quantity <= 0) return false;
      if (filters.stockStatus === "out" && quantity > 0) return false;
      if (filters.stockStatus === "low" && !(quantity > 0 && quantity <= variant.lowStockThreshold)) return false;
      return true;
    })
  );
}

function StockBadge({ quantity, lowThreshold }: { quantity: number; lowThreshold: number }) {
  const tone =
    quantity <= 0
      ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
      : quantity <= lowThreshold
        ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
        : "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300";
  return (
    <span className={cn("inline-flex min-w-9 justify-center rounded-full px-2 py-0.5 text-sm font-bold", tone)}>
      {quantity}
    </span>
  );
}

export function RetailCatalogList({
  products,
  filters,
  selected,
  onToggle,
  onToggleProduct,
  onOpenProduct,
  onEdit,
  onArchiveProduct,
  onVariantAction,
}: {
  products: RetailProduct[];
  filters: RetailCatalogFilters;
  selected: Set<number>;
  onToggle: (variantId: number) => void;
  onToggleProduct: (variantIds: number[], select: boolean) => void;
  onOpenProduct: (product: RetailProduct) => void;
  onEdit: (product: RetailProduct) => void;
  onArchiveProduct: (product: RetailProduct, active: boolean) => void;
  onVariantAction: (action: RetailVariantAction, product: RetailProduct, variant: RetailVariant) => void;
}) {
  const groups: Array<{ brand: string; products: RetailProduct[] }> = [];
  for (const product of products) {
    const last = groups[groups.length - 1];
    if (last && last.brand === product.brand.name) last.products.push(product);
    else groups.push({ brand: product.brand.name, products: [product] });
  }

  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <section key={group.brand} className="space-y-3" data-testid="brand-group">
          <h2 className="border-b pb-1 text-lg font-bold uppercase tracking-wide" data-no-translate>
            {group.brand}
          </h2>
          {group.products.map((product) => {
            const rows = visibleVariants(product, filters);
            const rowIds = rows.map((variant) => variant.id);
            const allSelected = rowIds.length > 0 && rowIds.every((id) => selected.has(id));
            const styleQuantity = rows.reduce((sum, variant) => sum + variantQuantity(variant, filters.locationId), 0);
            return (
              <Card key={product.id} className={cn(!product.active && "opacity-70")} data-testid="style-card">
                <CardContent className="space-y-3 p-3 sm:p-4">
                  <div className="flex items-start gap-3">
                    <button type="button" onClick={() => onOpenProduct(product)} className="shrink-0">
                      <ProductImageGallery
                        product={product}
                        maxImages={3}
                        imageClassName="h-16 w-16 rounded-md border"
                      />
                    </button>
                    <div className="min-w-0 flex-1">
                      <button
                        type="button"
                        className="block max-w-full truncate text-left text-base font-semibold hover:underline"
                        onClick={() => onOpenProduct(product)}
                        data-no-translate
                      >
                        {product.name}
                      </button>
                      <div className="text-xs text-muted-foreground" data-no-translate>
                        {[product.category, product.availableColors.join(", ")].filter(Boolean).join(" · ")}
                      </div>
                      <div className="mt-1 text-sm">
                        <span className="text-muted-foreground" data-i18n-ui>
                          In stock
                        </span>{" "}
                        <strong>{styleQuantity}</strong>
                        {!product.active && (
                          <span className="ml-2 rounded-sm bg-muted px-1.5 py-0.5 text-xs" data-i18n-ui>
                            Archived
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Edit"
                        title="Edit"
                        onClick={() => onEdit(product)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={product.active ? "Archive style" : "Restore style"}
                        title={product.active ? "Archive style" : "Restore style"}
                        onClick={() => onArchiveProduct(product, !product.active)}
                      >
                        {product.active ? <Archive className="h-4 w-4" /> : <ArchiveRestore className="h-4 w-4" />}
                      </Button>
                    </div>
                  </div>

                  {rows.length > 0 && (
                    <div className="divide-y rounded-md border">
                      <label className="flex items-center gap-2 bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground">
                        <Checkbox
                          checked={allSelected}
                          onCheckedChange={(value) => onToggleProduct(rowIds, value === true)}
                        />
                        <span>Select all sizes</span>
                      </label>
                      {rows.map((variant) => {
                        const quantity = variantQuantity(variant, filters.locationId);
                        const images = normalizeRetailImageUrls(
                          variant.imageUrls.length ? variant.imageUrls : product.imageUrls
                        );
                        return (
                          <div
                            key={variant.id}
                            className={cn(
                              "flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-2",
                              !variant.active && "bg-muted/40 opacity-70"
                            )}
                            data-testid="variant-row"
                          >
                            <Checkbox
                              aria-label="Select for labels"
                              checked={selected.has(variant.id)}
                              onCheckedChange={() => onToggle(variant.id)}
                            />
                            <div className="flex shrink-0 -space-x-2">
                              {(images.length ? images.slice(0, 3) : [""]).map((src, imageIndex) => (
                                <RetailImage
                                  key={src || `empty-${variant.id}`}
                                  src={src}
                                  alt={
                                    src
                                      ? `${product.name} · ${variant.color} · ${variant.size} photo ${imageIndex + 1}`
                                      : ""
                                  }
                                  className="h-10 w-10 rounded-sm border-2 border-background"
                                />
                              ))}
                              {images.length > 3 && (
                                <span className="flex h-10 w-10 items-center justify-center rounded-sm border-2 border-background bg-muted text-[10px] font-bold">
                                  +{images.length - 3}
                                </span>
                              )}
                            </div>
                            <div className="min-w-28 flex-1" data-no-translate>
                              <div className="font-semibold">
                                {variant.color} / {variant.size}
                                {!variant.active && <span className="ml-1 text-xs font-normal">(archived)</span>}
                              </div>
                              <div className="font-mono text-[11px] text-muted-foreground">
                                {variant.barcode} · {money(variant.sellingPrice)}
                              </div>
                            </div>
                            <StockBadge quantity={quantity} lowThreshold={variant.lowStockThreshold} />
                            <div className="hidden min-w-32 text-xs text-muted-foreground md:block" data-no-translate>
                              {variant.stocks
                                .filter((stock) => stock.quantity !== 0)
                                .map((stock) => `${stock.locationName}: ${stock.quantity}`)
                                .join(" · ") || "—"}
                            </div>
                            <div className="ml-auto flex gap-0.5">
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-8 w-8"
                                aria-label="Print barcode label"
                                title="Print barcode label"
                                onClick={() => onVariantAction("print", product, variant)}
                              >
                                <Printer className="h-4 w-4" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-8 w-8"
                                aria-label="Transfer"
                                title="Transfer"
                                onClick={() => onVariantAction("transfer", product, variant)}
                              >
                                <ArrowRightLeft className="h-4 w-4" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-8 w-8"
                                aria-label="Adjust stock"
                                title="Adjust stock"
                                onClick={() => onVariantAction("adjust", product, variant)}
                              >
                                <SlidersHorizontal className="h-4 w-4" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-8 w-8"
                                aria-label="Movement history"
                                title="Movement history"
                                onClick={() => onVariantAction("history", product, variant)}
                              >
                                <History className="h-4 w-4" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-8 w-8"
                                aria-label={variant.active ? "Archive variant" : "Restore variant"}
                                title={variant.active ? "Archive variant" : "Restore variant"}
                                onClick={() =>
                                  onVariantAction(variant.active ? "archive" : "restore", product, variant)
                                }
                              >
                                {variant.active ? (
                                  <Archive className="h-4 w-4" />
                                ) : (
                                  <ArchiveRestore className="h-4 w-4" />
                                )}
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </section>
      ))}
    </div>
  );
}
