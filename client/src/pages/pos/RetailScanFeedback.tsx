import { AlertTriangle, Ban, CheckCircle2, HelpCircle, ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { money, type RetailPosItem, type ScanOutcome } from "./retailPosTypes";

export function RetailItemImage({
  item,
  className,
}: {
  item: Pick<RetailPosItem, "imageUrls" | "name">;
  className?: string;
}) {
  const src = item.imageUrls?.[0];
  if (!src) {
    return (
      <div
        className={cn(
          "flex h-14 w-14 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground",
          className
        )}
      >
        <ImageIcon className="h-5 w-5" />
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={item.name}
      loading="lazy"
      decoding="async"
      className={cn("h-14 w-14 shrink-0 rounded-md object-cover", className)}
    />
  );
}

const TONE = {
  added: "border-emerald-500/70 bg-emerald-50 dark:bg-emerald-950/30",
  warning: "border-amber-500/70 bg-amber-50 dark:bg-amber-950/30",
  out: "border-destructive/70 bg-red-50 dark:bg-red-950/30",
  inactive: "border-destructive/70 bg-red-50 dark:bg-red-950/30",
  unknown: "border-destructive/70 bg-red-50 dark:bg-red-950/30",
  error: "border-destructive/70 bg-red-50 dark:bg-red-950/30",
} as const;

/** Large "last scan" panel: what was scanned, whether it went into the cart, and why not. */
export function RetailScanFeedback({ outcome }: { outcome: ScanOutcome | null }) {
  if (!outcome) {
    return (
      <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground" data-i18n-ui>
        Ready to scan. Point the scanner at a label.
      </div>
    );
  }
  if (outcome.status === "unknown" || outcome.status === "error") {
    return (
      <div className={cn("flex items-center gap-3 rounded-lg border-2 p-4", TONE[outcome.status])} role="alert">
        <HelpCircle className="h-8 w-8 shrink-0 text-destructive" />
        <div className="min-w-0">
          <div className="font-semibold" data-i18n-ui>
            {outcome.status === "unknown" ? "Unknown barcode" : "Scan failed"}
          </div>
          <div className="truncate font-mono text-sm">{outcome.barcode}</div>
          {outcome.status === "error" && <div className="text-sm">{outcome.message}</div>}
        </div>
      </div>
    );
  }

  const { item } = outcome;
  const tone = outcome.status === "added" ? (outcome.warning ? "warning" : "added") : outcome.status;
  const Icon = outcome.status === "added" ? (outcome.warning ? AlertTriangle : CheckCircle2) : Ban;
  return (
    <div
      className={cn("flex items-center gap-3 rounded-lg border-2 p-3", TONE[tone])}
      role={outcome.status === "added" && !outcome.warning ? "status" : "alert"}
      data-testid="scan-feedback"
    >
      <RetailItemImage item={item} className="h-20 w-20" />
      <div className="min-w-0 flex-1" data-no-translate>
        <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide">
          <Icon className="h-4 w-4" />
          <span data-i18n-ui>
            {outcome.status === "added"
              ? outcome.warning
                ? "Added — check stock"
                : "Added to cart"
              : outcome.status === "inactive"
                ? "Archived item — not sold"
                : outcome.cartQuantity && item.quantity > 0
                  ? "All available stock is already in the cart"
                  : item.otherLocations?.length
                    ? "Not in stock at this location"
                    : "Out of stock"}
          </span>
        </div>
        <div className="truncate font-semibold">
          {item.brand} · {item.name}
        </div>
        <div className="text-sm">
          <strong>{item.color}</strong> · <strong>{item.size}</strong> · {money(item.price)}
        </div>
        <div className="text-xs text-muted-foreground">
          <span data-i18n-ui>Available here</span>: {item.quantity}
          {outcome.status === "added" && (
            <>
              {" "}
              · <span data-i18n-ui>In cart</span>: {outcome.cartQuantity}
            </>
          )}
        </div>
        {outcome.status === "added" && outcome.warning && <div className="text-xs">{outcome.warning}</div>}
        {outcome.status === "out" && Boolean(item.otherLocations?.length) && (
          <div className="text-xs">
            <span data-i18n-ui>Available at</span>:{" "}
            {item.otherLocations!.map((entry) => `${entry.locationName} (${entry.quantity})`).join(", ")}
          </div>
        )}
      </div>
    </div>
  );
}
