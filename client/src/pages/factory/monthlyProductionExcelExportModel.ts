// Extracted from ./monthlyProductionExcelExport.ts
import type { UniversalExcelAppearance } from "@shared/universal-excel/design";
import { type MonthlyProductionExportBale } from "./monthlyProductionWorkbookDrilldown";

export type MonthlyProductionExcelRow = {
  productId: number;
  name: string;
  articleCode: string;
  categoryName: string;
  values: number[];
};

export type MonthlyProductionExcelOptions = {
  rows: MonthlyProductionExcelRow[];
  months: string[];
  monthLabels: string[];
  category: string;
  search: string;
  bales: MonthlyProductionExportBale[];
  appearance?: UniversalExcelAppearance;
};

export const PALETTE = {
  navy: "FF182437",
  blue: "FF1E40AF",
  title: "FF0F172A",
  subdued: "FF475569",
  border: "FFE2E8F0",
  white: "FFFFFFFF",
  stripe: "FFF1F5F9",
  emeraldFill: "FFD1FAE5",
  emeraldText: "FF065F46",
  redFill: "FFFEE2E2",
  redText: "FF991B1B",
  totalFill: "FFDBEAFE",
  totalText: "FF1E3A8A",
};
