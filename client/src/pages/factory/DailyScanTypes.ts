// Extracted from ./DailyScan.tsx to keep that module under the source-size cap.

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
