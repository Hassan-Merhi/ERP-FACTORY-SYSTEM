import {
  FACTORY_TRACKING_STATUSES,
  type FactoryStaffTrackingTranslationKey,
} from "@/i18n/factoryStaffTrackingTranslations";
import { factoryApiRequest } from "@/lib/factoryApi";

/**
 * Types and pure helpers behind the production-targets page: period maths,
 * Excel-import normalisation, row grouping and the tracking read. Extracted so
 * the page component stays inside the repository's file-size boundary.
 */

export type PeriodType = "daily" | "weekly" | "monthly";
export type TrackingStatus = (typeof FACTORY_TRACKING_STATUSES)[keyof typeof FACTORY_TRACKING_STATUSES];

export interface ProductionRow {
  personType: "worker";
  personId: number;
  name: string;
  code: string | null;
  groupName?: string;
  category: string;
  targetBales: number | null;
  defaultTargetBales?: number | null;
  targetBalesOverridden?: boolean;
  producedBales: number | null;
  status: TrackingStatus;
  notes: string;
  active: boolean;
  linkGroupId?: number | null;
  linkedWorkerIds?: number[];
  linkedWorkers?: Array<{ workerId: number; workerName: string }>;
}

export interface ProductionResponse {
  page: "production";
  periodType: PeriodType;
  periodStart: string;
  periodEnd: string;
  finalized?: boolean;
  finalizedAt?: string | null;
  rows: ProductionRow[];
}

export interface ProductionGroup {
  label: string;
  rows: ProductionRow[];
}

export interface ImportedProductionTarget {
  category: string;
  targetBales: number | null;
}

export function localDateStr(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function parseLocalDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function addIsoDays(value: string, days: number): string {
  const date = parseLocalDate(value);
  date.setDate(date.getDate() + days);
  return localDateStr(date);
}

export function periodFor(type: PeriodType, referenceDate: string) {
  const date = parseLocalDate(referenceDate);
  if (type === "daily") return { start: referenceDate, end: referenceDate };
  if (type === "monthly") {
    return {
      start: localDateStr(new Date(date.getFullYear(), date.getMonth(), 1)),
      end: localDateStr(new Date(date.getFullYear(), date.getMonth() + 1, 0)),
    };
  }

  const day = date.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const start = new Date(date);
  start.setDate(date.getDate() + mondayOffset);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return { start: localDateStr(start), end: localDateStr(end) };
}

export function summarizeProductionRows(sourceRows: ProductionRow[]) {
  let target = 0;
  let produced = 0;
  const countedLinks = new Set<number>();

  for (const row of sourceRows) {
    if (row.linkGroupId != null) {
      if (countedLinks.has(row.linkGroupId)) continue;
      countedLinks.add(row.linkGroupId);
    }
    target += row.targetBales ?? 0;
    produced += row.producedBales ?? 0;
  }

  return { target, produced, difference: produced - target };
}

export function updateLinkedTargetRows(
  sourceRows: ProductionRow[],
  personId: number,
  targetBales: number | null
): ProductionRow[] {
  const source = sourceRows.find((row) => row.personId === personId);
  const linkId = source?.linkGroupId ?? null;
  return sourceRows.map((row) =>
    row.personId === personId || (linkId !== null && row.linkGroupId === linkId)
      ? { ...row, targetBales }
      : row
  );
}

export function differenceText(target: number | null, produced: number | null) {
  if (target === null || produced === null) return "—";
  const difference = produced - target;
  return difference > 0 ? `+${difference}` : String(difference);
}

export function differenceClass(target: number | null, produced: number | null) {
  if (target === null || produced === null) return "text-muted-foreground";
  const difference = produced - target;
  if (difference > 0) return "text-emerald-600 dark:text-emerald-400";
  if (difference < 0) return "text-red-600 dark:text-red-400";
  return "text-foreground";
}

export function statusTranslationKey(status: TrackingStatus): FactoryStaffTrackingTranslationKey {
  if (status === FACTORY_TRACKING_STATUSES.absent) return "absent";
  if (status === FACTORY_TRACKING_STATUSES.new) return "new";
  return "present";
}

export function normalizeExcelHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

export function normalizeWorkerCode(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase();
}

export function groupProductionRows(sourceRows: ProductionRow[]): ProductionGroup[] {
  const groups = new Map<string, ProductionGroup>();

  for (const row of sourceRows) {
    // Production Targets are organized by the editable production category
    // (JEANS PANT, BLOUSE, TSHIRT, etc.), not by the broader worker group
    // such as "Pressing workers". This keeps every worker doing the same
    // category together even when they share one planner group.
    const label = row.category.trim() || row.groupName?.trim() || "";
    const key = label.toLocaleLowerCase();
    const existing = groups.get(key);
    if (existing) existing.rows.push(row);
    else groups.set(key, { label, rows: [row] });
  }

  return [...groups.values()]
    .sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: "base", numeric: true }))
    .map((group) => ({
      ...group,
      rows: [...group.rows].sort((left, right) =>
        left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true })
      ),
    }));
}

export async function fetchProduction(periodType: PeriodType, start: string, end: string): Promise<ProductionResponse> {
  const params = new URLSearchParams({
    page: "production",
    periodType,
    periodStart: start,
    periodEnd: end,
  });
  const response = await factoryApiRequest("GET", `/api/factory/staff-tracking?${params.toString()}`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || `Request failed (${response.status})`);
  }
  return response.json();
}

export function waitForReportPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}
