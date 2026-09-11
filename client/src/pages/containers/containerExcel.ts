/**
 * Safely extract a primitive value from an ExcelJS cell (which can return rich
 * objects). Non-primitive shapes that are not recognised fall back to "".
 */
export type ExcelCellPrimitive = string | number | boolean | Date;

const isExcelCellPrimitive = (v: unknown): v is ExcelCellPrimitive =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v instanceof Date;

const primitiveOrEmpty = (v: unknown): ExcelCellPrimitive => (isExcelCellPrimitive(v) ? v : "");

interface ExcelJsCellModel {
  result?: unknown;
  richText?: unknown;
  text?: unknown;
  hyperlink?: unknown;
}

export const cellVal = (value: unknown): ExcelCellPrimitive => {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value;
  if (typeof value !== "object") return primitiveOrEmpty(value);
  const cell = value as ExcelJsCellModel;
  // Formula cell: { result, formula }
  if ("result" in cell) return primitiveOrEmpty(cell.result);
  // Rich-text cell: { richText: [{ text, font }, ...] }
  if ("richText" in cell && Array.isArray(cell.richText)) {
    return cell.richText
      .map((r) => (typeof r === "object" && r !== null && "text" in r && typeof r.text === "string" ? r.text : ""))
      .join("");
  }
  // Shared-string / cell-model: { text }
  if ("text" in cell) return primitiveOrEmpty(cell.text);
  // Hyperlink cell: { text, hyperlink }
  if ("hyperlink" in cell) return primitiveOrEmpty(cell.text);
  return "";
};

export const cellStr = (value: unknown): string => String(cellVal(value));

export const cellNum = (value: unknown): string => {
  const v = cellVal(value);
  if (v === "") return "";
  const n = parseFloat(String(v).replace(/,/g, ""));
  return isNaN(n) ? "" : String(n);
};

export const excelDateToString = (value: unknown): string => {
  if (!value) return "";

  const toYMD = (d: Date): string => {
    const y = d.getFullYear();
    const m = (d.getMonth() + 1).toString().padStart(2, "0");
    const day = d.getDate().toString().padStart(2, "0");
    return `${y}-${m}-${day}`;
  };

  // JavaScript Date object (ExcelJS returns these for date cells)
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? "" : toYMD(value);
  }

  // ExcelJS cell-model object that has a 'result' property
  if (typeof value === "object" && value !== null) {
    if ("result" in value && value.result instanceof Date) return toYMD(value.result);
    if ("text" in value) return excelDateToString(value.text);
    return "";
  }

  // Excel serial number (integer days since Dec 30 1899)
  const num = Number(value);
  if (!isNaN(num) && num > 40000 && num < 60000) {
    const excelEpoch = new Date(1899, 11, 30);
    return toYMD(new Date(excelEpoch.getTime() + num * 24 * 60 * 60 * 1000));
  }

  // String: try to normalise common formats to YYYY-MM-DD
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return "";
    // Already YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    // MM/DD/YY  or  MM/DD/YYYY
    const slashMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (slashMatch) {
      const [, m, d, yRaw] = slashMatch;
      const y = yRaw.length === 2 ? (parseInt(yRaw) >= 50 ? `19${yRaw}` : `20${yRaw}`) : yRaw;
      return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    }
    // DD-MM-YYYY or DD/MM/YYYY (European style — less common but possible)
    // Try native Date parse as last resort
    const parsed = new Date(s);
    if (!isNaN(parsed.getTime())) return toYMD(parsed);
    return s;
  }

  return "";
};
