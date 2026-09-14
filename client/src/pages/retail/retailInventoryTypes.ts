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
  description: string | null;
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
  brandName: string;
  category: string;
  description: string;
  imageUrls: string;
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
  brandName: "",
  category: "",
  description: "",
  imageUrls: "",
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
