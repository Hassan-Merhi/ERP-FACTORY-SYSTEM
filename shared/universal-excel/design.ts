/**
 * Dakzo Systems universal Excel design tokens and print presentation.
 *
 * Report-only styling; never apply these transformations to machine-readable
 * import templates, canonical invoice builders or custom worksheets.
 * Defaults are code-defined; the Phase 9 settings service supplies validated,
 * company-scoped overrides without changing import-template contracts.
 */
import type ExcelJS from "exceljs";

export type UniversalExcelPreset = "dakzo" | "slate";

export interface UniversalExcelAppearance {
  preset?: UniversalExcelPreset;
  /** Visible on report metadata and print headers; does not alter worksheet data. */
  brandName?: string;
  /** Optional #RRGGBB or RRGGBB override for primary/title/header colors. */
  accentColor?: string;
  showBranding?: boolean;
  alternateRows?: boolean;
  printLayout?: boolean;
  /** Embedded small PNG or JPEG for wide report metadata banners only. */
  logoDataUrl?: string | null;
  headerText?: string;
  footerText?: string;
  showCompanyName?: boolean;
  showExportDate?: boolean;
  dateFormat?: "dd/mm/yyyy" | "mm/dd/yyyy";
}

export interface UniversalExcelPalette {
  primary: string;
  onPrimary: string;
  bodyText: string;
  mutedText: string;
  alternating: string;
  subtotal: string;
  grandTotal: string;
  border: string;
}

export interface ResolvedUniversalExcelAppearance {
  brandName: string;
  showBranding: boolean;
  alternateRows: boolean;
  printLayout: boolean;
  logoDataUrl: string | null;
  headerText: string;
  footerText: string;
  showCompanyName: boolean;
  showExportDate: boolean;
  dateFormat: "dd/mm/yyyy" | "mm/dd/yyyy";
  palette: UniversalExcelPalette;
  /** Full-row zebra fills are disabled consistently on large exports. */
  maxAlternatingRows: number;
}

const DEFAULT_PALETTE: UniversalExcelPalette = {
  primary: "FF183153",
  onPrimary: "FFFFFFFF",
  bodyText: "FF243449",
  mutedText: "FF617188",
  alternating: "FFF4F7FB",
  subtotal: "FFEAF1FA",
  grandTotal: "FFDCE8F8",
  border: "FFD9E2EF",
};

const SLATE_PALETTE: UniversalExcelPalette = {
  primary: "FF334155",
  onPrimary: "FFFFFFFF",
  bodyText: "FF1F2937",
  mutedText: "FF64748B",
  alternating: "FFF8FAFC",
  subtotal: "FFF1F5F9",
  grandTotal: "FFE2E8F0",
  border: "FFCBD5E1",
};

/** A non-invasive, report-only default brand and print policy. */
export const DEFAULT_UNIVERSAL_EXCEL_APPEARANCE: ResolvedUniversalExcelAppearance = {
  brandName: "DAKZO SYSTEMS",
  showBranding: true,
  alternateRows: true,
  printLayout: true,
  logoDataUrl: null,
  headerText: "",
  footerText: "",
  showCompanyName: true,
  showExportDate: true,
  dateFormat: "dd/mm/yyyy",
  palette: DEFAULT_PALETTE,
  maxAlternatingRows: 3_000,
};

function readableTextOn(color: string): string {
  const components = [2, 4, 6].map((position) => parseInt(color.slice(position, position + 2), 16) / 255);
  const linear = components.map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  // Pick the foreground with better relative contrast on this accent.
  return luminance > 0.179 ? "FF172334" : "FFFFFFFF";
}

export function resolveUniversalExcelAppearance(
  options: UniversalExcelAppearance = {}
): ResolvedUniversalExcelAppearance {
  const preset = options.preset ?? "dakzo";
  if (preset !== "dakzo" && preset !== "slate") {
    throw new Error("Unsupported universal Excel design preset");
  }
  const rawBrand = options.brandName ?? DEFAULT_UNIVERSAL_EXCEL_APPEARANCE.brandName;
  const brandName = rawBrand.trim();
  if (!brandName || brandName.length > 70 || Array.from(rawBrand).some((char) => char.charCodeAt(0) < 32)) {
    throw new Error("Invalid Excel brand name");
  }
  const text = (raw: string | undefined, label: string): string => {
    if (raw === undefined) return "";
    if (raw.length > 90 || Array.from(raw).some(char => char.charCodeAt(0) < 32 || char === "&")) {
      throw new Error("Invalid Excel " + label);
    }
    return raw.trim();
  };
  const logoDataUrl = options.logoDataUrl ?? null;
  if (logoDataUrl !== null &&
      (logoDataUrl.length > 185_000 ||
       !/^data:image\\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(logoDataUrl))) {
    throw new Error("Invalid Excel logo");
  }
  const base = preset === "slate" ? SLATE_PALETTE : DEFAULT_PALETTE;
  let primary = base.primary;
  if (options.accentColor !== undefined) {
    if (!/^#?[0-9A-Fa-f]{6}$/.test(options.accentColor)) {
      throw new Error("Invalid Excel accent color; expected #RRGGBB");
    }
    primary = "FF" + options.accentColor.replace("#", "").toUpperCase();
  }
  return {
    brandName,
    showBranding: options.showBranding ?? true,
    alternateRows: options.alternateRows ?? true,
    printLayout: options.printLayout ?? true,
    logoDataUrl,
    headerText: text(options.headerText, "print header"),
    footerText: text(options.footerText, "print footer"),
    showCompanyName: options.showCompanyName ?? true,
    showExportDate: options.showExportDate ?? true,
    dateFormat: options.dateFormat ?? "dd/mm/yyyy",
    palette: {
      ...base,
      primary,
      onPrimary: readableTextOn(primary),
    },
    maxAlternatingRows: DEFAULT_UNIVERSAL_EXCEL_APPEARANCE.maxAlternatingRows,
  };
}

export function paintExcelRow(
  worksheet: ExcelJS.Worksheet,
  rowNumber: number,
  columnCount: number,
  color: string
): void {
  const row = worksheet.getRow(rowNumber);
  for (let column = 1; column <= columnCount; column += 1) {
    row.getCell(column).fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
  }
}

export function styleUniversalExcelTotal(
  worksheet: ExcelJS.Worksheet,
  rowNumber: number,
  columnCount: number,
  design: ResolvedUniversalExcelAppearance,
  kind: "subtotal" | "grand-total"
): void {
  const row = worksheet.getRow(rowNumber);
  const fill = kind === "grand-total" ? design.palette.grandTotal : design.palette.subtotal;
  row.height = 23;
  row.font = { name: "Aptos", bold: true, size: 10, color: { argb: design.palette.bodyText } };
  paintExcelRow(worksheet, rowNumber, columnCount, fill);
  for (let col = 1; col <= columnCount; col += 1) {
    row.getCell(col).border = { top: { style: "thin", color: { argb: design.palette.border } } };
  }
}

export function styleUniversalExcelGroup(
  worksheet: ExcelJS.Worksheet,
  rowNumber: number,
  columnCount: number,
  design: ResolvedUniversalExcelAppearance
): void {
  paintExcelRow(worksheet, rowNumber, columnCount, design.palette.subtotal);
  const row = worksheet.getRow(rowNumber);
  row.height = 23;
  row.font = { name: "Aptos", bold: true, size: 10, color: { argb: design.palette.primary } };
}

function safePrintText(text: string): string {
  // Excel's header/footer control characters (&P, &N, etc.) must not come
  // from user-controlled report titles, filter labels or company names.
  return Array.from(text, (char) => (char === "&" ? "" : char.charCodeAt(0) < 32 ? " " : char))
    .join("")
    .slice(0, 90);
}

/**
 * Stable printable report defaults. No worksheet rows, columns, formulas or
 * sheet order are inserted or changed by this helper.
 */
export function applyUniversalExcelPrintLayout(
  worksheet: ExcelJS.Worksheet,
  args: {
    title: string;
    headerRow: number;
    lastRow: number;
    columnCount: number;
    design: ResolvedUniversalExcelAppearance;
  }
): void {
  if (!args.design.printLayout) return;
  worksheet.pageSetup.orientation = args.columnCount > 8 ? "landscape" : "portrait";
  worksheet.pageSetup.paperSize = 9; // A4
  worksheet.pageSetup.fitToPage = true;
  worksheet.pageSetup.fitToWidth = 1;
  worksheet.pageSetup.fitToHeight = 0;
  worksheet.pageSetup.printTitlesRow = "1:" + args.headerRow;
  worksheet.pageSetup.printArea =
    "A1:" + worksheet.getColumn(args.columnCount).letter + Math.max(args.headerRow, args.lastRow);
  worksheet.pageSetup.margins = {
    left: 0.3,
    right: 0.3,
    top: 0.65,
    bottom: 0.65,
    header: 0.25,
    footer: 0.25,
  };
  const brand = args.design.showBranding ? safePrintText(args.design.brandName) : "";
  const title = safePrintText(args.title);
  const headerText = args.design.headerText ? safePrintText(args.design.headerText) : title;
  const footerText = args.design.footerText ? safePrintText(args.design.footerText) : "";
  worksheet.headerFooter.oddHeader = (brand ? "&L" + brand : "") + "&C" + headerText;
  worksheet.headerFooter.oddFooter = (footerText ? "&L" + footerText : brand ? "&L" + brand : "") +
    "&RPage &P of &N";
}
