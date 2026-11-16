// Extracted from ./RetailQuickAdd.tsx to keep that module under the source-size cap.
import { makeRetailIdempotencyKey } from "./retailIdempotency";

export const QUICK_SIZES = ["XS", "S", "M", "L", "XL", "XXL"];

export const COMMON_COLORS = [
  "Black",
  "White",
  "Beige",
  "Navy",
  "Grey",
  "Brown",
  "Blue",
  "Red",
  "Green",
  "Pink",
  "Cream",
];

export const LOCATION_STORAGE_KEY = "retail-quick-add-location";

export interface QuickVariant {
  key: string;
  color: string;
  size: string;
  quantity: number;
  cost: string;
  sellingPrice: string;
  sku: string;
  barcode: string;
  imageUrls: string[];
  pendingPreviews: string[];
}

export interface QuickAddResult {
  replayed: boolean;
  productId: number;
  createdProduct: boolean;
  variants: Array<{
    variantId: number;
    name: string;
    brand: string | null;
    color: string;
    size: string;
    barcode: string;
    barcodeSource: string;
    sellingPrice: number;
    receivedQuantity?: number;
  }>;
}

let keyCounter = 0;

const nextKey = () => `v${Date.now()}-${(keyCounter += 1)}`;

export const blankQuickVariant = (patch: Partial<QuickVariant> = {}): QuickVariant => ({
  key: nextKey(),
  color: "",
  size: "",
  quantity: 1,
  cost: "",
  sellingPrice: "",
  sku: "",
  barcode: "",
  imageUrls: [],
  pendingPreviews: [],
  ...patch,
});

export const variantKey = (variant: Pick<QuickVariant, "color" | "size">) =>
  `${variant.color.trim().toLowerCase().replace(/\s+/g, " ")}|${variant.size.trim().toLowerCase().replace(/\s+/g, " ")}`;

export const makeIdempotencyKey = () => makeRetailIdempotencyKey("retail-quick-add");

export function readStoredLocation(): number | "" {
  try {
    const value = Number(window.localStorage.getItem(LOCATION_STORAGE_KEY));
    return Number.isInteger(value) && value > 0 ? value : "";
  } catch {
    return "";
  }
}
