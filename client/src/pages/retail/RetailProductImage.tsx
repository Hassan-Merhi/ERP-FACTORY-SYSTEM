import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, ImageIcon, Images, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { normalizeRetailImageUrl, normalizeRetailImageUrls } from "@/lib/retailImageUrl";
import { cn } from "@/lib/utils";
import type { RetailProduct } from "./retailInventoryTypes";

/** Product-level photos first, followed by every exact variant's additional photos. */
export function retailProductImageUrls(product: RetailProduct): string[] {
  return normalizeRetailImageUrls([
    ...(product.imageUrls ?? []),
    ...(product.variants ?? []).flatMap((variant) => variant.imageUrls ?? []),
  ]);
}

export function RetailImage({ src, alt = "", className }: { src?: string | null; alt?: string; className?: string }) {
  const normalized = normalizeRetailImageUrl(src);
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [normalized]);

  if (!normalized || failed) {
    return (
      <div className={cn("flex items-center justify-center bg-muted text-muted-foreground", className)}>
        <ImageIcon className="h-5 w-5" aria-hidden="true" />
        {alt && <span className="sr-only">{alt} (photo unavailable)</span>}
      </div>
    );
  }

  return (
    <img
      src={normalized}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={cn("bg-muted object-cover", className)}
    />
  );
}

/** Lightweight cover photo for non-interactive contexts. */
export function ProductImage({ product, className }: { product: RetailProduct; className?: string }) {
  const sources = useMemo(() => retailProductImageUrls(product), [product]);
  const [sourceIndex, setSourceIndex] = useState(0);
  const sourceKey = sources.join("\n");

  useEffect(() => setSourceIndex(0), [sourceKey]);

  const src = sources[sourceIndex];
  if (!src) {
    return <RetailImage alt={product.name} className={className} />;
  }

  return (
    <img
      src={src}
      alt={product.name}
      loading="lazy"
      decoding="async"
      onError={() => setSourceIndex((current) => current + 1)}
      className={cn("bg-muted object-cover", className)}
    />
  );
}

interface RetailPhotoGalleryProps {
  images: ReadonlyArray<string | null | undefined>;
  title: string;
  className?: string;
  imageClassName?: string;
}

/**
 * A single cover image opens the whole photo collection. The modal uses the
 * existing accessible Radix dialog, handles keyboard arrows, offers a thumbnail
 * filmstrip, and allows zoom with horizontal/vertical scrolling.
 *
 * All media URLs use the existing company-agnostic retail media normalization.
 * No images or prices are modified by viewing the gallery.
 */
export function RetailPhotoGallery({
  images,
  title,
  className,
  imageClassName = "h-16 w-16 rounded-md border",
}: RetailPhotoGalleryProps) {
  const sources = normalizeRetailImageUrls([...images]);
  const sourcesKey = sources.join("\n");
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [zoomed, setZoomed] = useState(false);

  // Reset when the selected product changes or the dialog is opened again.
  useEffect(() => {
    if (open) {
      setIndex(0);
      setZoomed(false);
    }
  }, [open, sourcesKey]);

  const selectedIndex = Math.min(index, Math.max(0, sources.length - 1));
  const current = sources[selectedIndex];
  const hasMultiple = sources.length > 1;
  const show = (next: number) => {
    setIndex((next + sources.length) % sources.length);
    setZoomed(false);
  };

  const handleKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!hasMultiple || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      event.stopPropagation();
      show(selectedIndex + (event.key === "ArrowRight" ? 1 : -1));
    }
  };

  if (!sources.length) {
    return <RetailImage alt={title} className={cn(imageClassName, className)} />;
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className={cn(
            "group relative block shrink-0 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            className
          )}
          aria-label={`View all photos of ${title}`}
          aria-haspopup="dialog"
          title="View all product photos"
          data-testid="retail-gallery-trigger"
        >
          <RetailImage src={sources[0]} alt={title} className={imageClassName} />
          <span className="absolute bottom-1 right-1 rounded-sm bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white">
            <Images className="mr-1 inline h-3 w-3" aria-hidden="true" />
            {sources.length}
          </span>
          <span className="sr-only">Open photo gallery</span>
        </button>
      </DialogTrigger>

      <DialogContent
        className="flex max-h-[96vh] w-[96vw] max-w-5xl flex-col gap-3 overflow-hidden p-3 sm:p-5"
        onKeyDown={handleKeys}
        data-testid="retail-photo-gallery"
      >
        <DialogHeader>
          <DialogTitle data-no-translate>{title}</DialogTitle>
          <DialogDescription>
            Photo {selectedIndex + 1} of {sources.length}. Use left and right arrow keys to browse.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between gap-2 pr-10">
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {selectedIndex + 1} / {sources.length}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setZoomed((value) => !value)}
            aria-pressed={zoomed}
            aria-label={zoomed ? "Zoom out photo" : "Zoom in photo"}
          >
            {zoomed ? <ZoomOut className="mr-1.5 h-4 w-4" /> : <ZoomIn className="mr-1.5 h-4 w-4" />}
            {zoomed ? "Fit photo" : "Zoom"}
          </Button>
        </div>
        <div className="relative min-h-0 flex-1 rounded-lg border bg-muted/30">
          <div className="h-[min(59vh,610px)] w-full overflow-auto overscroll-contain">
            <div className={cn("min-h-full w-full p-2", zoomed && "w-[180%]")}>
              <RetailImage
                key={current}
                src={current}
                alt={`${title} — photo ${selectedIndex + 1}`}
                className={cn("mx-auto w-full rounded-md object-contain", !zoomed && "max-h-[min(57vh,590px)]")}
              />
            </div>
          </div>
          {hasMultiple && (
            <>
              <Button
                type="button"
                size="icon"
                variant="secondary"
                className="absolute left-2 top-1/2 h-10 w-10 -translate-y-1/2 rounded-full shadow-md"
                onClick={() => show(selectedIndex - 1)}
                aria-label="Previous photo"
              >
                <ChevronLeft className="h-5 w-5" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="secondary"
                className="absolute right-2 top-1/2 h-10 w-10 -translate-y-1/2 rounded-full shadow-md"
                onClick={() => show(selectedIndex + 1)}
                aria-label="Next photo"
              >
                <ChevronRight className="h-5 w-5" />
              </Button>
            </>
          )}
        </div>
        {hasMultiple && (
          <div className="flex w-full gap-2 overflow-x-auto pb-1" role="group" aria-label="Choose product photo">
            {sources.map((src, photoIndex) => (
              <button
                key={src}
                type="button"
                onClick={() => show(photoIndex)}
                aria-label={`Show photo ${photoIndex + 1} of ${sources.length}`}
                aria-current={photoIndex === selectedIndex ? "true" : undefined}
                className={cn(
                  "shrink-0 rounded-md p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  photoIndex === selectedIndex ? "ring-2 ring-primary" : "opacity-70 hover:opacity-100"
                )}
              >
                <RetailImage src={src} alt="" className="h-14 w-14 rounded-sm object-cover sm:h-16 sm:w-16" />
              </button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ProductImageGallery({
  product,
  className,
  imageClassName = "h-16 w-16 rounded-md border",
}: {
  product: RetailProduct;
  className?: string;
  imageClassName?: string;
}) {
  return (
    <RetailPhotoGallery
      images={retailProductImageUrls(product)}
      title={`${product.brand.name} · ${product.name}`}
      className={className}
      imageClassName={imageClassName}
    />
  );
}
