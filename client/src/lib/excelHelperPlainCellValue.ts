// Extracted from ./excelHelper.ts to keep that module under the source-size cap.
import ExcelJS from "exceljs";

export interface ExcelRange {
  s: { r: number; c: number };
  e: { r: number; c: number };
}

type SpreadsheetValue = unknown;

type SpreadsheetRow = SpreadsheetValue[];

interface SheetMetadata {
  "!cols"?: Array<{ wch?: number }>;
  "!freeze"?: { xSplit?: number; ySplit?: number };
  "!merges"?: ExcelRange[];
}

interface ArraySheet extends SheetMetadata {
  aoa: SpreadsheetRow[];
}

interface JsonSheet<Row extends object = Record<string, unknown>> extends SheetMetadata {
  data: Row[];
  headers: string[];
}

type SheetData = ArraySheet | JsonSheet<object>;

function readRowValue(row: object, header: string): unknown {
  return (row as Record<string, unknown>)[header];
}

const colToNum = (col: string): number => {
  let num = 0;
  for (let i = 0; i < col.length; i++) {
    num = num * 26 + col.charCodeAt(i) - 64;
  }
  return num - 1;
};

const numToCol = (num: number): string => {
  let col = "";
  num++;
  while (num > 0) {
    num--;
    col = String.fromCharCode(65 + (num % 26)) + col;
    num = Math.floor(num / 26);
  }
  return col;
};

/**
 * The value an importer wants from a cell: a formula's result, a hyperlink's
 * text, and the joined text of a rich-text cell (one with mixed formatting),
 * which ExcelJS otherwise returns as { richText: [...] }.
 */
function plainCellValue(value: ExcelJS.CellValue): unknown {
  let plain: unknown = value;
  if (plain && typeof plain === "object" && "result" in plain) plain = plain.result;
  if (plain && typeof plain === "object" && "richText" in plain && Array.isArray(plain.richText)) {
    return plain.richText.map((part: { text?: unknown }) => (typeof part.text === "string" ? part.text : "")).join("");
  }
  if (plain && typeof plain === "object" && "text" in plain) plain = plain.text;
  return plain;
}

const parseOrigin = (origin: string | { r: number; c: number } | undefined): { r: number; c: number } => {
  if (!origin) return { r: 0, c: 0 };
  if (typeof origin === "object") return origin;
  const m = origin.match(/^([A-Z]+)(\d+)$/);
  if (!m) return { r: 0, c: 0 };
  return { r: parseInt(m[2]) - 1, c: colToNum(m[1]) };
};

export const utils = {
  book_new: () => new ExcelJS.Workbook(),

  json_to_sheet: <Row extends object>(data: Row[], options?: { header?: string[] }): JsonSheet<Row> => {
    if (!data || data.length === 0) {
      return { data: [], headers: options?.header ?? [] };
    }
    const headers = options?.header ?? Object.keys(data[0]);
    return { data, headers };
  },

  aoa_to_sheet: (data: SpreadsheetRow[] | null | undefined): ArraySheet => {
    return { aoa: data ?? [] };
  },

  sheet_add_aoa: (
    sheet: ArraySheet,
    rows: SpreadsheetRow[],
    options?: { origin?: string | { r: number; c: number } }
  ) => {
    if (!sheet.aoa) sheet.aoa = [];
    const { r: r0, c: c0 } = parseOrigin(options?.origin);
    rows.forEach((row, ri) => {
      const target = r0 + ri;
      if (!sheet.aoa![target]) sheet.aoa![target] = [];
      row.forEach((val, ci) => {
        sheet.aoa![target][c0 + ci] = val;
      });
    });
    return sheet;
  },

  encode_col: (c: number): string => numToCol(c),

  encode_range: (range: ExcelRange): string => {
    return `${numToCol(range.s.c)}${range.s.r + 1}:${numToCol(range.e.c)}${range.e.r + 1}`;
  },

  decode_range: (range: string): ExcelRange => {
    const match = range.match(/([A-Z]+)(\d+):([A-Z]+)(\d+)/);
    if (!match) {
      return { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
    }
    return {
      s: { r: parseInt(match[2]) - 1, c: colToNum(match[1]) },
      e: { r: parseInt(match[4]) - 1, c: colToNum(match[3]) },
    };
  },

  encode_cell: (cell: { r: number; c: number }): string => {
    return numToCol(cell.c) + (cell.r + 1);
  },

  book_append_sheet: (workbook: ExcelJS.Workbook, sheetData: SheetData, name: string) => {
    const worksheet = workbook.addWorksheet(name);

    if ("aoa" in sheetData) {
      for (const row of sheetData.aoa) {
        worksheet.addRow(row || []);
      }
    } else if ("data" in sheetData && "headers" in sheetData) {
      worksheet.addRow(sheetData.headers);
      for (const item of sheetData.data) {
        const row: SpreadsheetRow = [];
        for (const header of sheetData.headers) {
          row.push(readRowValue(item, header) ?? "");
        }
        worksheet.addRow(row);
      }
    }

    if (sheetData["!cols"]) {
      sheetData["!cols"].forEach((col: { wch?: number }, idx: number) => {
        if (col?.wch) {
          worksheet.getColumn(idx + 1).width = col.wch;
        }
      });
    }

    if (sheetData["!freeze"]) {
      const fz = sheetData["!freeze"];
      worksheet.views = [
        {
          state: "frozen",
          xSplit: fz.xSplit ?? 0,
          ySplit: fz.ySplit ?? 0,
        },
      ];
    }

    return worksheet;
  },

  sheet_to_json: <T = Record<string, unknown>>(
    worksheet: ExcelJS.Worksheet,
    options?: { header?: number | string; defval?: unknown }
  ): T[] => {
    const data: T[] = [];
    const headers: string[] = [];
    const defval = options?.defval;

    if (options?.header === 1) {
      worksheet.eachRow((row) => {
        const rowData: SpreadsheetRow = [];
        row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          rowData[colNumber - 1] = plainCellValue(cell.value);
        });
        data.push(rowData as unknown as T);
      });
      return data;
    }

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) {
        row.eachCell((cell, colNumber) => {
          headers[colNumber - 1] = String(cell.value || "");
        });
      } else {
        const rowData: Record<string, unknown> = {};
        row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          const header = headers[colNumber - 1];
          if (header) {
            rowData[header] = plainCellValue(cell.value);
          }
        });
        if (defval !== undefined) {
          for (const h of headers) {
            if (h && rowData[h] === undefined) rowData[h] = defval;
          }
        }
        if (Object.keys(rowData).length > 0) {
          data.push(rowData as unknown as T);
        }
      }
    });

    return data;
  },
};
