// Extracted from ./columns.ts
import type { UniversalExcelColumn, UniversalExcelColumnType } from "./engine";

export interface UniversalExcelDimension {
  id: string | number;
  label: string;
  /** Hidden dimensions remain out of the workbook completely. */
  enabled?: boolean;
  /**
   * Position in a source array (if sourceFormat = array), independent of
   * display order. Use when the underlying matrix arrives in month order.
   */
  index?: number;
  /** Extra column visibility requirement. Not an authorization substitute. */
  permissionTag?: string;
}

export type UniversalExcelColumnOrder = "provided" | "label" | "id" | "period";

export type UniversalExcelMissingValue =
  { mode: "blank" } | { mode: "zero" } | { mode: "error" } | { mode: "fallback"; key: string };

export interface UniversalExcelColumnFamily {
  /** Stable key namespace, e.g. location_price or month_count. */
  namespace: string;
  /** Key of the record/map/array on each data row. */
  sourceKey: string;
  dimensions: readonly UniversalExcelDimension[];
  headerPrefix?: string;
  headerSuffix?: string;
  type: UniversalExcelColumnType;
  width?: number;
  numFmt?: string;
  permissionTag?: string;
  order?: UniversalExcelColumnOrder;
  sourceFormat?: "record" | "array";
  missing?: UniversalExcelMissingValue;
}

/** Insert whole families before/after a known base key, without key guessing. */
export interface UniversalExcelColumnInsertion {
  columns: readonly UniversalExcelColumn[];
  after?: string;
  before?: string;
}

export interface UniversalExcelLocation {
  id: number | string;
  name: string;
  enabled?: boolean;
}

export interface UniversalExcelMonth {
  period: string; // YYYY-MM
  label: string;
  enabled?: boolean;
}
