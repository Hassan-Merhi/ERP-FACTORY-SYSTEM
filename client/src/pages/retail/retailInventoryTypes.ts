export const NO_BRAND = "Other / No Brand";
export const MAX_PRODUCT_IMAGES = 8;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export interface Brand {
  id: number;
  name: string;
  isNoBrand: boolean;
}

export interface Location {
  id: number;
  code: string;
  name: string;
  active?: boolean;
}

export interface RetailStock {
  locationId: number;
  locationName: string;
  quantity: number;
}

export interface RetailVariant {
  id: number;
  size: string;
  barcode: string;
  sku: string | null;
  cost: number;
  sellingPrice: number;
  lowStockThreshold: number;
  active: boolean;
  quantity: number;
  stocks: RetailStock[];
}

export interface RetailProduct {
  id: number;
  code: string;
  name: string;
  category: string | null;
  imageUrls: string[];
  active: boolean;
  brand: { id: number | null; name: string };
  variants: RetailVariant[];
  availableSizes: string[];
  totalQuantity: number;
  minSellingPrice: number;
  maxSellingPrice: number;
}

export interface RetailCatalogPage {
  items: RetailProduct[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface RetailCatalogFacets {
  sizes: string[];
  categories: string[];
}

export interface DraftStock {
  locationId: number | "";
  quantity: number;
}

export interface DraftVariant {
  id?: number;
  size: string;
  barcode: string;
  sku: string;
  cost: number;
  sellingPrice: number;
  lowStockThreshold: number;
  active: boolean;
  stocks: DraftStock[];
}

export interface ProductDraft {
  code: string;
  name: string;
  brandId: number | "";
  category: string;
  imageUrls: string[];
  active: boolean;
  variants: DraftVariant[];
}

export const blankVariant = (): DraftVariant => ({
  size: "",
  barcode: "",
  sku: "",
  cost: 0,
  sellingPrice: 0,
  lowStockThreshold: 0,
  active: true,
  stocks: [{ locationId: "", quantity: 0 }],
});

export const blankDraft = (): ProductDraft => ({
  code: "",
  name: "",
  brandId: "",
  category: "",
  imageUrls: [],
  active: true,
  variants: [blankVariant()],
});

export async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || `Request failed (${response.status})`);
  }
  return response.json();
}

export function money(value: number) {
  return new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value || 0);
}

export function buildInternalProductCode(name: string, brand: string) {
  const identity = `${brand}-${name}`
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}-]+/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `RTL-${identity || "item"}`.slice(0, 100);
}
