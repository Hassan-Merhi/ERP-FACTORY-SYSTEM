import { useEffect, useMemo, useState } from "react";
import { ImageIcon } from "lucide-react";
import { normalizeRetailImageUrl, normalizeRetailImageUrls } from "@/lib/retailImageUrl";
import { cn } from "@/lib/utils";
import type { RetailProduct } from "./retailInventoryTypes";

export function retailProductImageUrls(product: RetailProduct): string[] {
  return normalizeRetailImageUrls([
    ...(product.imageUrls ?? []),
    ...(product.variants ?? []).flatMap((variant) => variant.imageUrls ?? []),
  ]);
}

export function RetailImage({
  src,
  alt = "",
  className,
}: {
  src?: string | null;
  alt?: string;
  className?: string;
}) {
  const normalized = normalizeRetailImageUrl(src);
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [normalized]);

  if (!normalized || failed) {
    return (
      <div className={cn("flex items-center justify-center bg-muted text-muted-foreground", className)}>
        <ImageIcon className="h-5 w-5" />
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

export function ProductImage({ product, className }: { product: RetailProduct; className?: string }) {
  const sources = useMemo(() => retailProductImageUrls(product), [product]);
  const [sourceIndex, setSourceIndex] = useState(0);
  const sourceKey = sources.join("\n");

  useEffect(() => setSourceIndex(0), [sourceKey]);

  const src = sources[sourceIndex];
  if (!src) {
    return (
      <div className={cn("flex items-center justify-center bg-muted text-muted-foreground", className)}>
        <ImageIcon className="h-5 w-5" />
      </div>
    );
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

export function ProductImageGallery({
  product,
  maxImages = 4,
  className,
  imageClassName = "h-16 w-16 rounded-md border",
}: {
  product: RetailProduct;
  maxImages?: number;
  className?: string;
  imageClassName?: string;
}) {
  const sources = retailProductImageUrls(product);
  if (!sources.length) {
    return <ProductImage product={product} className={imageClassName} />;
  }

  const shown = sources.slice(0, Math.max(1, maxImages));
  const extra = Math.max(0, sources.length - shown.length);

  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {shown.map((src, index) => (
        <div key={src} className="relative shrink-0">
          <RetailImage src={src} alt={index === 0 ? product.name : `${product.name} photo ${index + 1}`} className={imageClassName} />
          {extra > 0 && index === shown.length - 1 && (
            <span className="absolute inset-0 flex items-center justify-center rounded-md bg-black/55 text-xs font-bold text-white">
              +{extra}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
