import { useQuery } from "@tanstack/react-query";
import { A4_DESIGN_OPTIONS, setBannerTimestamps } from "@/lib/labelHtml";

export interface DesignColorOption {
  value: string;
  label: string;
  color: string;
  previewUrl: string;
  isDefault: boolean;
  hasCustom?: boolean;
  lastModified?: number | null;
  id?: number;
  slug?: string;
  colorHex?: string;
}

interface LabelDesignColorRow {
  id: number;
  slug: string;
  label: string;
  colorHex: string;
  isDefault: boolean;
  hasCustom: boolean;
  lastModified: number | null;
}

const STATIC_FALLBACK: DesignColorOption[] = A4_DESIGN_OPTIONS.map((o) => ({
  ...o,
  isDefault: true,
  hasCustom: false,
  lastModified: null,
}));

function rowToOption(r: LabelDesignColorRow): DesignColorOption {
  const ts: number | null = r.hasCustom && r.lastModified ? r.lastModified : null;
  // previewUrl is for screen/UI display only (small WebP thumbnail).
  // Custom images use the original URL (stable ?t= timestamp → browser caches correctly).
  // Print always uses getDesignBannerUrl() from labelHtml.ts which uses the full-res original.
  const previewUrl = ts
    ? `/labels/hmd-${r.slug}.jpg?t=${ts}` // custom image, stable cache key
    : `/labels/previews/hmd-${r.slug}-preview.webp`; // default → small preview
  return {
    id: r.id,
    slug: r.slug,
    value: r.slug,
    label: r.label,
    color: r.colorHex,
    colorHex: r.colorHex,
    previewUrl,
    isDefault: r.isDefault,
    hasCustom: r.hasCustom,
    lastModified: r.lastModified,
  };
}

export function useLabelDesignColors() {
  const query = useQuery<DesignColorOption[]>({
    queryKey: ["/api/factory/label-design-colors"],
    queryFn: () =>
      fetch("/api/factory/label-design-colors", { credentials: "include" })
        .then((r) => r.json() as Promise<unknown>)
        .then((rows) => {
          const colors = Array.isArray(rows) ? (rows as LabelDesignColorRow[]).map(rowToOption) : STATIC_FALLBACK;
          const timestamps: Record<string, number | null> = {};
          for (const c of colors) {
            timestamps[c.value] = c.hasCustom && c.lastModified ? c.lastModified : null;
          }
          setBannerTimestamps(timestamps);
          return colors;
        }),
    staleTime: 30_000,
  });

  return {
    colors: query.data ?? STATIC_FALLBACK,
    isLoading: query.isLoading,
    refetch: query.refetch,
  };
}
