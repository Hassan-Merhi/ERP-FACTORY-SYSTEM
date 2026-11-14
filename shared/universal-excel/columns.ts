/**
 * Phase 4: declarative smart-column families for ERP, Factory and Properties.
 *
 * A family expands one configured dimension per visible Excel column. The
 * source stays nested (pricesByLocation, amountsByCurrency, monthCounts, etc.)
 * so we do not allocate full flattened copies of large datasets. All accessors
 * are read-only; external authorization is mandatory before passing records.
 */
import type { UniversalExcelColumn, UniversalExcelColumnType, UniversalExcelRecord } from "./engine";

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

function compareKey(left: string, right: string): number {
  return left.localeCompare(right, "en", { numeric: true, sensitivity: "base" });
}

function validToken(token: string): boolean {
  return /^[a-z][a-z0-9_]*$/i.test(token);
}

function validateDimension(dimension: UniversalExcelDimension): void {
  const id = String(dimension.id);
  if (
    !id.trim() ||
    !dimension.label.trim() ||
    Array.from(id + dimension.label).some((char) => char.charCodeAt(0) < 32)
  ) {
    throw new Error("Invalid Excel column dimension id or label");
  }
  if (dimension.index !== undefined && (!Number.isSafeInteger(dimension.index) || dimension.index < 0)) {
    throw new Error("Invalid Excel source array index: " + id);
  }
}

function sourceAt(
  row: UniversalExcelRecord,
  sourceKey: string,
  id: string,
  index: number,
  format: "record" | "array"
): unknown {
  const values = row[sourceKey];
  if (format === "array") {
    if (values == null) return undefined;
    if (!Array.isArray(values)) throw new Error("Expected Excel column array at " + sourceKey);
    return values[index];
  }
  if (values == null) return undefined;
  if (Array.isArray(values) || typeof values !== "object" || values instanceof Date) {
    throw new Error("Expected Excel column record at " + sourceKey);
  }
  // JSON-safe object maps; do not read from prototypes or inherited fields.
  if (!Object.prototype.hasOwnProperty.call(values, id)) return undefined;
  return (values as Record<string, unknown>)[id];
}

export function buildUniversalExcelDimensionColumns(family: UniversalExcelColumnFamily): UniversalExcelColumn[] {
  const { namespace, sourceKey } = family;
  if (!validToken(namespace) || !sourceKey.trim()) {
    throw new Error("Invalid dynamic Excel namespace or source key");
  }
  if (family.width !== undefined && (!Number.isFinite(family.width) || family.width <= 0)) {
    throw new Error("Invalid dynamic Excel column width");
  }
  const format = family.sourceFormat ?? "record";
  const order = family.order ?? "provided";
  if (!["record", "array"].includes(format) || !["provided", "label", "id", "period"].includes(order)) {
    throw new Error("Invalid dynamic Excel column family options");
  }
  const rawMembers = family.dimensions.map((dimension, originalIndex) => ({
    ...dimension,
    originalIndex,
    idText: String(dimension.id),
    labelText: dimension.label.trim(),
  }));
  const seenIds = new Set<string>();
  const seenLabels = new Set<string>();
  for (const member of rawMembers) {
    validateDimension(member);
    const normalizedId = member.idText.toLowerCase();
    const normalizedLabel = member.labelText.toLocaleLowerCase("en");
    if (seenIds.has(normalizedId) || seenLabels.has(normalizedLabel)) {
      throw new Error("Duplicate dynamic Excel dimension: " + member.idText);
    }
    seenIds.add(normalizedId);
    seenLabels.add(normalizedLabel);
    if (order === "period" && !/^\d{4}-(0[1-9]|1[0-2])$/.test(member.idText)) {
      throw new Error("Invalid Excel month period: " + member.idText);
    }
  }
  const sorted = rawMembers.filter((member) => member.enabled !== false);
  if (order === "label") sorted.sort((a, b) => compareKey(a.labelText, b.labelText) || compareKey(a.idText, b.idText));
  else if (order === "id") sorted.sort((a, b) => compareKey(a.idText, b.idText));
  else if (order === "period") sorted.sort((a, b) => a.idText.localeCompare(b.idText));

  const missing = family.missing ?? { mode: "blank" as const };
  if (missing.mode !== "blank" && missing.mode !== "zero" && missing.mode !== "fallback" && missing.mode !== "error") {
    throw new Error("Invalid dynamic Excel missing-value policy");
  }
  if (missing.mode === "fallback" && !missing.key.trim()) {
    throw new Error("Invalid dynamic Excel fallback key");
  }
  const permittedSourceKeys = [sourceKey, ...(missing.mode === "fallback" ? [missing.key] : [])];
  return sorted.map((member) => {
    // Use a percent-encoded ID, never the display label, as the stable key.
    const key = namespace + "__" + encodeURIComponent(member.idText);
    const column: UniversalExcelColumn = {
      key,
      header: (family.headerPrefix ?? "") + member.labelText + (family.headerSuffix ?? ""),
      type: family.type,
      width: family.width,
      numFmt: family.numFmt,
      permissionTag: family.permissionTag,
      permissionTags: member.permissionTag ? [member.permissionTag] : undefined,
      sourceKeys: permittedSourceKeys,
      value: (row: UniversalExcelRecord) => {
        const value = sourceAt(row, sourceKey, member.idText, member.index ?? member.originalIndex, format);
        if (value !== null && value !== undefined && value !== "") return value;
        if (missing.mode === "zero") return 0;
        if (missing.mode === "error") {
          throw new Error("Missing dynamic Excel value for " + namespace + ": " + member.idText);
        }
        if (missing.mode === "fallback") return row[missing.key];
        return null;
      },
    };
    return column;
  });
}

function ensureColumnIds(columns: readonly UniversalExcelColumn[]): void {
  const keys = new Set<string>();
  for (const column of columns) {
    const key = column.key.toLocaleLowerCase("en");
    if (keys.has(key)) throw new Error("Duplicate Excel column key: " + column.key);
    keys.add(key);
  }
}

/**
 * Combine base fields with dynamic column families at stable anchors. Multiple
 * insertions after the same anchor remain in the order supplied by the caller.
 */
export function composeUniversalExcelColumns(
  base: readonly UniversalExcelColumn[],
  insertions: readonly UniversalExcelColumnInsertion[]
): UniversalExcelColumn[] {
  const merged = [...base];
  ensureColumnIds(merged);
  const lastInsertedAfter = new Map<string, string>();
  for (const insertion of insertions) {
    if (insertion.after && insertion.before) throw new Error("Cannot specify both before and after");
    if (!insertion.columns.length) continue;
    const anchorKey = insertion.after || insertion.before;
    let position = merged.length;
    if (anchorKey) {
      const anchor = insertion.after ? (lastInsertedAfter.get(anchorKey) ?? anchorKey) : anchorKey;
      const match = merged.findIndex((column) => column.key === anchor);
      if (match < 0) throw new Error("Unknown Excel column insertion anchor: " + anchorKey);
      position = match + (insertion.after ? 1 : 0);
    }
    merged.splice(position, 0, ...insertion.columns);
    ensureColumnIds(merged);
    if (insertion.after) {
      lastInsertedAfter.set(insertion.after, insertion.columns[insertion.columns.length - 1].key);
    }
  }
  return merged;
}

/** Explicit conditional fields; never infer access rights from a data value. */
export function selectUniversalExcelConditionalColumns(
  candidates: readonly { column: UniversalExcelColumn; enabled: boolean }[]
): UniversalExcelColumn[] {
  const selected = candidates.filter((candidate) => candidate.enabled).map((candidate) => candidate.column);
  ensureColumnIds(selected);
  return selected;
}

export interface UniversalExcelLocation {
  id: number | string;
  name: string;
  enabled?: boolean;
}

/** ERP Stock Items: dynamic Price - <Location> fields, alphabetically. */
export function buildLocationPriceColumns(
  locations: readonly UniversalExcelLocation[],
  options: {
    sourceKey?: string;
    fallbackPriceKey?: string;
    permissionTag?: string;
    width?: number;
  } = {}
): UniversalExcelColumn[] {
  return buildUniversalExcelDimensionColumns({
    namespace: "location_price",
    sourceKey: options.sourceKey ?? "pricesByLocation",
    dimensions: locations.map((location) => ({
      id: location.id,
      label: location.name,
      enabled: location.enabled,
    })),
    type: "money",
    width: options.width ?? 18,
    permissionTag: options.permissionTag,
    headerPrefix: "Price - ",
    order: "label",
    ...(options.fallbackPriceKey ? { missing: { mode: "fallback" as const, key: options.fallbackPriceKey } } : {}),
  });
}

export interface UniversalExcelMonth {
  period: string; // YYYY-MM
  label: string;
  enabled?: boolean;
}

/** Factory: chronological month columns; optional positional matrix arrays. */
export function buildProductionMonthColumns(
  months: readonly UniversalExcelMonth[],
  options: { sourceKey?: string; sourceFormat?: "record" | "array" } = {}
): UniversalExcelColumn[] {
  return buildUniversalExcelDimensionColumns({
    namespace: "production_month",
    sourceKey: options.sourceKey ?? "monthCounts",
    sourceFormat: options.sourceFormat ?? "record",
    dimensions: months.map((month) => ({
      id: month.period,
      label: month.label,
      enabled: month.enabled,
    })),
    type: "integer",
    width: 16,
    order: "period",
    // Each array position is a specified month; a shortened array indicates
    // mismatched report data and must not silently leave a month blank.
    missing: (options.sourceFormat ?? "record") === "array" ? { mode: "error" } : { mode: "blank" },
  });
}

/** Financial: optional per-currency amounts or six-decimal FX rate columns. */
export function buildCurrencyColumns(
  currencies: readonly string[],
  options: {
    measure: "amount" | "fx-rate";
    sourceKey?: string;
    permissionTag?: string;
  }
): UniversalExcelColumn[] {
  for (const currency of currencies) {
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Invalid Excel currency code: " + currency);
  }
  return buildUniversalExcelDimensionColumns({
    namespace: options.measure === "fx-rate" ? "currency_fx_rate" : "currency_amount",
    sourceKey: options.sourceKey ?? (options.measure === "fx-rate" ? "fxRatesByCurrency" : "amountsByCurrency"),
    dimensions: currencies.map((currency) => ({ id: currency, label: currency })),
    type: options.measure === "fx-rate" ? "decimal" : "money",
    numFmt: options.measure === "fx-rate" ? "#,##0.000000" : "#,##0.00",
    permissionTag: options.permissionTag,
    headerPrefix: options.measure === "fx-rate" ? "FX Rate (" : "Amount (",
    headerSuffix: ")",
    order: "id",
    width: 18,
  });
}

/** Page-specific, explicitly declared optional attributes (no key guessing). */
export function buildAttributeColumns(
  attributes: readonly (UniversalExcelDimension & { type?: UniversalExcelColumnType })[],
  options: { sourceKey?: string; order?: UniversalExcelColumnOrder } = {}
): UniversalExcelColumn[] {
  // Attributes may carry different types, so build one at a time in the
  // requested order. Validate duplicate headers and IDs as one family first.
  const common = {
    namespace: "attribute",
    sourceKey: options.sourceKey ?? "attributes",
    dimensions: attributes,
    type: "text" as const,
    order: options.order ?? "provided",
  };
  const columns = buildUniversalExcelDimensionColumns(common);
  const typeById = new Map(attributes.map((attribute) => [String(attribute.id), attribute.type ?? "text"]));
  return columns.map((column) => {
    const id = decodeURIComponent(column.key.slice("attribute__".length));
    return { ...column, type: typeById.get(id) };
  });
}
