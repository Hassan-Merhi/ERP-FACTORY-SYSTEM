import { ImageIcon } from "lucide-react";
import type { RetailProduct } from "./retailInventoryTypes";

export function ProductImage({ product, className }: { product: RetailProduct; className?: string }) {
  const src = product.imageUrls?.[0];
  if (!src) {
    return (
      <div className={`flex items-center justify-center bg-muted text-muted-foreground ${className ?? ""}`}>
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
      className={`object-cover bg-muted ${className ?? ""}`}
    />
  );
}
