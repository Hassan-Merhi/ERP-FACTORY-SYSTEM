import { z } from "zod";

/** User-controlled report inputs must be validated on both API and saved views. */
export const PRESSING_REPORT_COLUMNS = [
  "referenceNumber", "articleCode", "productName", "weightKg",
  "machineName", "operatorName", "shiftId", "productionDate",
  "confirmedAt", "deviceCapturedAt", "secondsSincePrevious", "status", "bales", "firstScanAt", "lastScanAt",
] as const;
export type PressingReportColumn = (typeof PRESSING_REPORT_COLUMNS)[number];
export const PRESSING_COLUMN_LABELS: Record<PressingReportColumn, string> = {
  referenceNumber: "Bale Reference", articleCode: "Article Code",
  productName: "Bale Name", weightKg: "KG", machineName: "Machine",
  operatorName: "Operator", shiftId: "Shift ID", productionDate: "Production Date",
  confirmedAt: "Server Scan Time", deviceCapturedAt: "Device Capture Time",
  secondsSincePrevious: "Seconds Since Previous", status: "Status",
  bales: "Bales", firstScanAt: "First Scan", lastScanAt: "Last Scan",
};
export const PRESSING_DEFAULT_COLUMNS: PressingReportColumn[] = [
  "referenceNumber", "articleCode", "weightKg", "machineName",
  "operatorName", "productionDate", "confirmedAt", "secondsSincePrevious",
];
const dateFilter = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value =>
  !Number.isNaN(Date.parse(value + "T00:00:00Z")) &&
  new Date(value + "T00:00:00Z").toISOString().slice(0,10) === value,
  "Use a valid YYYY-MM-DD calendar date");
const positiveInt = z.coerce.number().int().positive();
export const pressingReportFiltersSchema = z.object({
  from: dateFilter.optional(),
  to: dateFilter.optional(),
  asOf: z.string().datetime({ offset: true }).optional(),
  machineId: positiveInt.optional(),
  userId: z.string().trim().min(1).max(255).optional(),
  shiftId: positiveInt.optional(),
  articleCode: z.string().trim().min(1).max(50).optional(),
  search: z.string().trim().min(1).max(100).optional(),
  status: z.enum(["active", "voided", "all"]).default("active"),
  mode: z.enum(["detailed", "condensed"]).default("detailed"),
  page: positiveInt.max(100000).default(1),
  limit: positiveInt.max(250).default(100),
}).strict();
export type PressingReportFilters = z.infer<typeof pressingReportFiltersSchema>;
export const pressingSavedViewSchema = z.object({
  name: z.string().trim().min(1).max(120),
  mode: z.enum(["detailed", "condensed"]),
  filters: pressingReportFiltersSchema.omit({
    asOf: true, mode: true, page: true, limit: true,
  }),
  visibleColumns: z.array(z.enum(PRESSING_REPORT_COLUMNS)).min(1).max(PRESSING_REPORT_COLUMNS.length),
  isDefault: z.boolean().default(false),
}).strict();
