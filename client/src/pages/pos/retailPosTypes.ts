import { apiRequest } from "@/lib/queryClient";
import { makeRetailIdempotencyKey } from "@/pages/retail/retailIdempotency";

export interface Location {
  id: number;
  code: string;
  name: string;
  city: string | null;
  state: string | null;
  country: string | null;
}

export interface RetailPosItem {
  variantId: number;
  productId: number;
  code: string;
  name: string;
  brand: string;
  imageUrls: string[];
  color: string;
  size: string;
  sku: string | null;
  barcode: string;
  price: number;
  quantity: number;
  active?: boolean;
  otherLocations?: Array<{ locationId: number; locationName: string; quantity: number }>;
}

export interface CartLine extends RetailPosItem {
  cartQuantity: number;
}

export interface SaleItem {
  id: number;
  variantId: number;
  quantity: number;
  returnedQuantity: number;
  unitPrice: number;
  name: string;
  code: string;
  color: string;
  size: string;
  barcode: string;
  sku: string | null;
  imageUrls: string[];
  brand: string;
}

export type RetailPaymentMethod = "cash" | "card" | "bank" | "mobile" | "other";

export interface RetailPaymentDraft {
  method: RetailPaymentMethod;
  amount: number;
  tenderedAmount?: number | null;
  reference?: string | null;
}

export interface RetailPayment {
  id: number;
  method: RetailPaymentMethod;
  paymentType: "payment" | "refund" | string;
  amount: number;
  tenderedAmount: number | null;
  changeAmount: number;
  reference: string | null;
  shiftId: number | null;
}

export interface RetailSale {
  id: number;
  locationId: number;
  status: string;
  shiftId?: number | null;
  accountingVoucherId?: number | null;
  totalAmount: number;
  createdAt: string;
  notes?: string | null;
  payments?: RetailPayment[];
  items: SaleItem[];
}

export type ScanOutcome =
  | { status: "added"; item: RetailPosItem; cartQuantity: number; warning?: string }
  | { status: "out"; item: RetailPosItem; cartQuantity?: number }
  | { status: "inactive"; item: RetailPosItem }
  | { status: "unknown"; barcode: string }
  | { status: "error"; barcode: string; message: string };

export async function readJson<T>(url: string): Promise<T> {
  const response = await apiRequest("GET", url);
  return (await response.json()) as T;
}

export function makeKey(prefix: string): string {
  return makeRetailIdempotencyKey(prefix);
}

export function money(value: number): string {
  return new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value || 0);
}

/** Mirrors the server rule in server/auth.ts: managers and above may sell into negative stock. */
export function canSellIntoNegative(company: { role?: string; canSellNegativeStock?: boolean | null } | null) {
  if (!company) return false;
  return (
    ["Admin", "Owner", "Manager", "Developer"].includes(company.role ?? "") || Boolean(company.canSellNegativeStock)
  );
}

/**
 * Looks up a scanned barcode and classifies the result so the cashier gets a
 * specific message (unknown, archived, or out of stock here) instead of a generic error.
 */
export async function lookupRetailBarcode(
  barcode: string,
  locationId: number
): Promise<{ kind: "found"; item: RetailPosItem } | { kind: "inactive"; item: RetailPosItem } | { kind: "unknown" }> {
  const response = await fetch(`/api/pos/retail/barcodes/${encodeURIComponent(barcode)}?locationId=${locationId}`, {
    credentials: "include",
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 404) return { kind: "unknown" };
  if (response.status === 409 && body?.code === "ITEM_INACTIVE") return { kind: "inactive", item: body.item };
  if (!response.ok) throw new Error(body?.message || `Barcode lookup failed (${response.status})`);
  return { kind: "found", item: body as RetailPosItem };
}

let audioContext: AudioContext | null = null;

/** Short confirmation tone so cashiers can scan without looking at the screen. */
export function scanBeep(ok: boolean) {
  try {
    const AudioCtor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) return;
    audioContext ??= new AudioCtor();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.frequency.value = ok ? 1320 : 220;
    gain.gain.value = 0.08;
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + (ok ? 0.08 : 0.3));
  } catch {
    // Sound is optional.
  }
}
