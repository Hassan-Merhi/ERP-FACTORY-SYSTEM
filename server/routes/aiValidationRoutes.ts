import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import Papa from "papaparse";
import { db } from "../db";
import { requireAuth } from "../auth";
import { upload } from "./_helpers";
import { readExcel, sheetToJson, createWorkbook, jsonToSheet, writeWorkbook } from "../excelHelper";
import { stockItems, stockItemCodeAliases } from "@shared/schema";
import { eq, and, isNull } from "drizzle-orm";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ValidationItem {
  row?: number;
  value?: string;
  message: string;
  detail?: string;
}

interface SuggestedFix {
  original: string;
  suggested: string;
  reason: string;
}

interface ValidationResult {
  validationType: string;
  file1Name: string | null;
  file2Name: string | null;
  summary: Record<string, unknown>;
  errors: ValidationItem[];
  warnings: ValidationItem[];
  suggestedFixes: SuggestedFix[];
  cleanedExcel: string | null; // base64 .xlsx
}

// ─── File parsing ─────────────────────────────────────────────────────────────

async function parseFile(buffer: Buffer, originalName: string): Promise<Record<string, unknown>[]> {
  const ext = originalName.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "csv") {
    const text = buffer.toString("utf-8");
    const result = Papa.parse<Record<string, unknown>>(text, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h: string) => h.trim(),
    });
    return result.data;
  }
  // Excel
  const wb = await readExcel(buffer);
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return [];
  return sheetToJson(wb.Sheets[sheetName]);
}

// ─── Column detection helpers ─────────────────────────────────────────────────

const CODE_HEADERS = [
  "code",
  "item code",
  "item_code",
  "sku",
  "article",
  "article code",
  "product code",
  "barcode",
  "part number",
  "part_number",
  "itemcode",
];
const NAME_HEADERS = [
  "name",
  "item name",
  "item_name",
  "product name",
  "product_name",
  "description",
  "desc",
  "title",
  "stockitem",
  "stock item",
];

function detectColumn(rows: Record<string, unknown>[], candidates: string[]): string | null {
  if (!rows.length) return null;
  const keys = Object.keys(rows[0]);
  for (const candidate of candidates) {
    const found = keys.find((k) => k.toLowerCase().trim() === candidate);
    if (found) return found;
  }
  // fuzzy: check if any key *contains* one of the candidates
  for (const candidate of candidates) {
    const found = keys.find((k) => k.toLowerCase().includes(candidate));
    if (found) return found;
  }
  return null;
}

// ─── Levenshtein distance ─────────────────────────────────────────────────────

function levenshtein(a: string, b: string): number {
  const m = a.length,
    n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function closeMatchThreshold(code: string): number {
  const len = code.length;
  if (len <= 4) return 1;
  if (len <= 8) return 2;
  return 3;
}

// ─── Name normalisation ───────────────────────────────────────────────────────

function normalizeName(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/\s*#\s*\d+\s*$/g, "") // trailing #1, #2
    .replace(/\s+no\.?\s*\d+\s*$/gi, "") // trailing "no 1", "no.2"
    .replace(/\s+-\s*[a-z]\s*$/gi, "") // trailing " - A", " - B"
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Validation: item_code_check ──────────────────────────────────────────────

async function runItemCodeCheck(
  companyId: number,
  rows: Record<string, unknown>[],
  file1Name: string
): Promise<ValidationResult> {
  const codeCol = detectColumn(rows, CODE_HEADERS);
  if (!codeCol) {
    return {
      validationType: "item_code_check",
      file1Name,
      file2Name: null,
      summary: { totalChecked: 0, message: "Could not detect a code column in the file." },
      errors: [{ message: `No code column found. Expected one of: ${CODE_HEADERS.slice(0, 5).join(", ")}` }],
      warnings: [],
      suggestedFixes: [],
      cleanedExcel: null,
    };
  }

  // Load DB codes
  const [dbPrimary, dbAliases] = await Promise.all([
    db
      .select({ id: stockItems.id, code: stockItems.code, name: stockItems.name })
      .from(stockItems)
      .where(and(eq(stockItems.companyId, companyId), eq(stockItems.active, true), isNull(stockItems.deletedAt))),
    db
      .select({ aliasCode: stockItemCodeAliases.aliasCode, stockItemId: stockItemCodeAliases.stockItemId })
      .from(stockItemCodeAliases)
      .where(eq(stockItemCodeAliases.companyId, companyId)),
  ]);

  const primaryMap = new Map(dbPrimary.map((r) => [r.code?.toLowerCase() ?? "", r]));
  const aliasMap = new Map(dbAliases.map((a) => [a.aliasCode.toLowerCase(), a.stockItemId]));
  const allDbCodes = [...primaryMap.keys(), ...aliasMap.keys()];

  // Count codes in upload (for intra-file duplicate detection)
  const uploadCodeCounts = new Map<string, number>();
  for (const row of rows) {
    const raw = String(row[codeCol] ?? "").trim();
    if (!raw) continue;
    const lower = raw.toLowerCase();
    uploadCodeCounts.set(lower, (uploadCodeCounts.get(lower) ?? 0) + 1);
  }

  const errors: ValidationItem[] = [];
  const warnings: ValidationItem[] = [];
  const suggestedFixes: SuggestedFix[] = [];
  const cleanedRows: Record<string, unknown>[] = [];

  let found = 0,
    missing = 0,
    duplicateInFile = 0,
    closeMatches = 0;
  const seenInFile = new Set<string>();

  rows.forEach((row, idx) => {
    const raw = String(row[codeCol] ?? "").trim();
    if (!raw) {
      cleanedRows.push({ ...row, _Status: "empty", _Detail: "No code value" });
      warnings.push({ row: idx + 2, message: "Empty code cell" });
      return;
    }
    const lower = raw.toLowerCase();
    let status: string;
    let detail = "";

    // Duplicate within file
    if (seenInFile.has(lower)) {
      duplicateInFile++;
      errors.push({ row: idx + 2, value: raw, message: `Duplicate code within file: "${raw}"` });
      status = "Duplicate (file)";
    } else {
      seenInFile.add(lower);

      if (primaryMap.has(lower)) {
        found++;
        status = "Found (primary)";
        detail = primaryMap.get(lower)!.name ?? "";
      } else if (aliasMap.has(lower)) {
        found++;
        status = "Found (alias)";
        const itemId = aliasMap.get(lower)!;
        const item = dbPrimary.find((i) => i.id === itemId);
        detail = item ? `Alias of: ${item.name}` : "Alias";
      } else {
        // Check close matches
        const close = allDbCodes
          .map((dbCode) => ({ dbCode, dist: levenshtein(lower, dbCode) }))
          .filter(({ dist }) => dist > 0 && dist <= closeMatchThreshold(lower))
          .sort((a, b) => a.dist - b.dist)
          .slice(0, 3);

        if (close.length) {
          closeMatches++;
          status = "Close Match";
          detail = close.map((c) => c.dbCode).join(", ");
          warnings.push({
            row: idx + 2,
            value: raw,
            message: `"${raw}" not found — close matches: ${detail}`,
            detail: `Levenshtein distance: ${close[0].dist}`,
          });
          suggestedFixes.push({
            original: raw,
            suggested: close[0].dbCode,
            reason: `Closest match in database (distance ${close[0].dist})`,
          });
        } else {
          missing++;
          status = "Missing";
          errors.push({ row: idx + 2, value: raw, message: `Code "${raw}" not found in stock items or aliases` });
        }
      }
    }

    cleanedRows.push({ ...row, _Status: status, _Detail: detail });
  });

  // Build cleaned Excel
  const wb = createWorkbook();
  jsonToSheet(wb, cleanedRows, "Validation Results");
  const excelBuf = await writeWorkbook(wb);
  const cleanedExcel = excelBuf.toString("base64");

  return {
    validationType: "item_code_check",
    file1Name,
    file2Name: null,
    summary: {
      totalChecked: rows.length,
      found,
      missing,
      duplicateInFile,
      closeMatches,
      codeColumn: codeCol,
      message: `${found} found, ${missing} missing, ${duplicateInFile} duplicates in file, ${closeMatches} close matches`,
    },
    errors,
    warnings,
    suggestedFixes,
    cleanedExcel,
  };
}

// ─── Validation: duplicate_name_check ────────────────────────────────────────

async function runDuplicateNameCheck(
  _companyId: number,
  rows: Record<string, unknown>[],
  file1Name: string
): Promise<ValidationResult> {
  const nameCol = detectColumn(rows, NAME_HEADERS);
  if (!nameCol) {
    return {
      validationType: "duplicate_name_check",
      file1Name,
      file2Name: null,
      summary: { totalChecked: 0, message: "Could not detect a name column in the file." },
      errors: [{ message: `No name column found. Expected one of: ${NAME_HEADERS.slice(0, 5).join(", ")}` }],
      warnings: [],
      suggestedFixes: [],
      cleanedExcel: null,
    };
  }

  // Group by normalised name
  const groups = new Map<string, { row: number; original: string }[]>();
  rows.forEach((row, idx) => {
    const raw = String(row[nameCol] ?? "").trim();
    if (!raw) return;
    const norm = normalizeName(raw);
    if (!groups.has(norm)) groups.set(norm, []);
    groups.get(norm)!.push({ row: idx + 2, original: raw });
  });

  const errors: ValidationItem[] = [];
  const warnings: ValidationItem[] = [];
  const suggestedFixes: SuggestedFix[] = [];
  const cleanedRows: Record<string, unknown>[] = [];
  let duplicateGroups = 0;
  let duplicateItems = 0;

  // Assign group letters A, B, C…
  const rowAnnotations = new Map<number, { group: string; suggested: string; norm: string }>();

  for (const [norm, members] of groups) {
    if (members.length < 2) continue;
    duplicateGroups++;
    duplicateItems += members.length;

    const baseName = members[0].original; // keep as-is
    members.forEach((m, i) => {
      const suffix = i === 0 ? "" : ` - ${String.fromCharCode(65 + i)}`; // A=65
      const suggested = i === 0 ? baseName : `${baseName}${suffix}`;
      rowAnnotations.set(m.row, { group: norm, suggested, norm });

      if (i === 0) {
        warnings.push({
          row: m.row,
          value: m.original,
          message: `Possible duplicate group: "${norm}" (${members.length} matches)`,
          detail: `Keep as: "${suggested}"`,
        });
      } else {
        errors.push({
          row: m.row,
          value: m.original,
          message: `Likely duplicate of "${members[0].original}" (normalises to "${norm}")`,
          detail: `Suggested rename: "${suggested}"`,
        });
        suggestedFixes.push({
          original: m.original,
          suggested,
          reason: `Normalises to same base name "${norm}" as "${members[0].original}"`,
        });
      }
    });
  }

  rows.forEach((row, idx) => {
    const rowNum = idx + 2;
    const ann = rowAnnotations.get(rowNum);
    cleanedRows.push({
      ...row,
      _NormalizedName: ann ? ann.norm : normalizeName(String(row[nameCol] ?? "")),
      _DuplicateGroup: ann ? ann.group : "",
      _SuggestedName: ann ? ann.suggested : row[nameCol],
    });
  });

  const wb = createWorkbook();
  jsonToSheet(wb, cleanedRows, "Duplicate Analysis");
  const excelBuf = await writeWorkbook(wb);
  const cleanedExcel = excelBuf.toString("base64");

  return {
    validationType: "duplicate_name_check",
    file1Name,
    file2Name: null,
    summary: {
      totalChecked: rows.length,
      duplicateGroups,
      duplicateItems,
      nameColumn: nameCol,
      message:
        duplicateGroups > 0
          ? `Found ${duplicateGroups} duplicate group(s) covering ${duplicateItems} row(s)`
          : "No duplicate names detected",
    },
    errors,
    warnings,
    suggestedFixes,
    cleanedExcel,
  };
}

// ─── Stub validators ──────────────────────────────────────────────────────────

function notImplemented(validationType: string, file1Name: string): ValidationResult {
  return {
    validationType,
    file1Name,
    file2Name: null,
    summary: { message: "This validation type is not yet implemented." },
    errors: [],
    warnings: [{ message: `"${validationType}" validation is coming soon.` }],
    suggestedFixes: [],
    cleanedExcel: null,
  };
}

// ─── Route registration ───────────────────────────────────────────────────────

export function registerAiValidationRoutes(app: Express) {
  const fileFields = upload.fields([
    { name: "file1", maxCount: 1 },
    { name: "file2", maxCount: 1 },
  ]);

  app.post("/api/ai-validation/run", requireAuth, fileFields, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const validationType = String(req.body.validationType ?? "").trim();
      if (!validationType) return res.status(400).json({ message: "validationType is required" });

      const files = req.files as Record<string, Express.Multer.File[]> | undefined;
      const f1 = files?.file1?.[0];

      const REQUIRES_FILE: Record<string, boolean> = {
        item_code_check: true,
        duplicate_name_check: true,
        statement_compare: true,
        po_compare: true,
        amount_total_check: true,
        currency_conversion_check: true,
      };

      if (REQUIRES_FILE[validationType] && !f1) {
        return res.status(400).json({ message: "A file is required for this validation type" });
      }

      let result: ValidationResult;

      switch (validationType) {
        case "item_code_check": {
          const rows = await parseFile(f1!.buffer, f1!.originalname);
          result = await runItemCodeCheck(companyId, rows, f1!.originalname);
          break;
        }
        case "duplicate_name_check": {
          const rows = await parseFile(f1!.buffer, f1!.originalname);
          result = await runDuplicateNameCheck(companyId, rows, f1!.originalname);
          break;
        }
        default:
          result = notImplemented(validationType, f1?.originalname ?? "");
      }

      res.json(result);
    } catch (err: unknown) {
      logger.error("[AI Validation] run error:", { error: getErrorMessage(err) });
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}
