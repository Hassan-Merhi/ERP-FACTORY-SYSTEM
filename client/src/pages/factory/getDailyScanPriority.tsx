// Extracted from ./DailyScan.tsx to keep that module under the source-size cap.
import { Badge } from "@/components/ui/badge";

export function toLocalDateStr(d: Date): string {
  return d.toLocaleDateString("en-CA");
}

export function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return toLocalDateStr(d);
}

export function formatDisplay(dateStr: string): string {
  const [y, m, day] = dateStr.split("-");
  return `${day}/${m}/${y}`;
}

export interface DayBale {
  id: number;
  reference_number: string;
  article_code: string | null;
  product_name: string | null;
  weight_kg: string | null;
  status: string;
  is_in_loading_order: boolean;
  is_deleted: boolean;
  date_bale_produced: string | null;
  worker_name: string | null;
  scan_id: number | null;
  scanned_at: string | null;
}

export interface SavedScan {
  id: number;
  scan_date: string;
  reference_number: string;
  scanned_at: string;
}

export function StatusBadge({
  status,
  isInLoadingOrder,
  isDeleted,
}: {
  status: string;
  isInLoadingOrder: boolean;
  isDeleted: boolean;
}) {
  if (isDeleted) return <Badge className="daily-scan-status bg-red-600 text-white border-0">Deleted</Badge>;
  const s = (status || "").toUpperCase();
  if (isInLoadingOrder || s === "LOADING" || s === "LOADED")
    return <Badge className="daily-scan-status bg-amber-500 text-white border-0">Pending Loading</Badge>;
  if (s === "IN_STOCK") return <Badge className="daily-scan-status bg-green-600 text-white border-0">In Stock</Badge>;
  if (s === "SOLD") return <Badge className="daily-scan-status bg-red-600 text-white border-0">Sold</Badge>;
  if (s === "RESERVED_FOR_ORDER")
    return <Badge className="daily-scan-status bg-blue-600 text-white border-0">Reserved</Badge>;
  return <Badge variant="outline">{status || "—"}</Badge>;
}

export interface ScanFeedback {
  type: "success" | "error" | "warn";
  refCode: string;
  productName?: string | null;
  articleCode?: string | null;
  message: string;
}

function getDailyScanPriority(bale: DayBale): number {
  if (bale.is_deleted) return 2;

  const status = (bale.status || "").toUpperCase();

  // Match the visible status badge: a bale already tied to a loading is no
  // longer an "In Stock" priority row even if its underlying bale status is
  // still IN_STOCK (V5 loading flow keeps that status until finalization).
  if (
    bale.is_in_loading_order ||
    status === "LOADING" ||
    status === "LOADED" ||
    status === "PENDING" ||
    status === "PENDING_LOADING" ||
    status === "SOLD" ||
    status === "DISPATCHED"
  ) {
    return 2;
  }

  if (status === "IN_STOCK") return 0;
  return 1;
}

export function prioritizeDailyScanBales(bales: DayBale[]): DayBale[] {
  return bales
    .map((bale, index) => ({ bale, index }))
    .sort((a, b) => getDailyScanPriority(a.bale) - getDailyScanPriority(b.bale) || a.index - b.index)
    .map(({ bale }) => bale);
}
