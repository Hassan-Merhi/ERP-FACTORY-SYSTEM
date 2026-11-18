// Extracted from ./_helpers.ts to keep that module under the source-size cap.
import multer from "multer";
import { sizeLimitLabel, spreadsheetImportLimitBytes } from "@shared/fileSizePolicy";
import path from "path";

// ── In-memory undo store for bulk Excel imports ────────────────────────────
// Keyed by importId (UUID). Stores the "before" snapshot so the last import
// can be rolled back. Entries expire after 2 hours to prevent unbounded growth.
export const importUndoStore = new Map<
  string,
  {
    companyId: number;
    createdAt: number;
    changes: Array<{ id: number; containerNumber: string; prevData: Record<string, unknown> }>;
  }
>();

export const UNDO_TTL_MS = 2 * 60 * 60 * 1000;

// 2 hours
export const MAX_IMPORT_UNDO_ENTRIES = Math.max(
  2,
  Number.parseInt(process.env.GIT_IMPORT_UNDO_MAX_ENTRIES || "20", 10) || 20
);

export function pruneImportUndoStore(now = Date.now()): void {
  for (const [key, entry] of importUndoStore) {
    if (now - entry.createdAt >= UNDO_TTL_MS) importUndoStore.delete(key);
  }
  while (importUndoStore.size > MAX_IMPORT_UNDO_ENTRIES) {
    const oldestKey = importUndoStore.keys().next().value;
    if (oldestKey === undefined) break;
    importUndoStore.delete(oldestKey);
  }
}

export const importUndoCleanupTimer = setInterval(() => pruneImportUndoStore(), 15 * 60 * 1000);

export const ALLOWED_EXCEL_MIME = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
];

export const ALLOWED_EXCEL_EXT = [".xlsx", ".xls"];

export const gitUpload = {
  single(fieldName: string) {
    return (req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => {
      const maxBytes = spreadsheetImportLimitBytes(req.session?.currentRole);
      multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: maxBytes, files: 1 },
        fileFilter: (_req, file, cb) => {
          const ext = path.extname(file.originalname).toLowerCase();
          if (ALLOWED_EXCEL_MIME.includes(file.mimetype) && ALLOWED_EXCEL_EXT.includes(ext)) {
            cb(null, true);
          } else {
            cb(new Error("Only Excel files (.xlsx, .xls) are allowed"));
          }
        },
      }).single(fieldName)(req, res, (err) => {
        if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
          res.status(413).json({
            code: "UPLOAD_FILE_TOO_LARGE",
            message: `File exceeds the ${sizeLimitLabel(maxBytes)} Excel import limit.`,
          });
          return;
        }
        next(err);
      });
    };
  },
};

// ─── Types ────────────────────────────────────────────────────────────────────

export type WarningCode =
  "no_open_balance" | "ledger_exceeds_containers" | "allocation_gap" | "fuzzy_match" | "no_account_linked";

export type AllocStatus = "Cleared" | "Partially Cleared" | "Open";

export interface ContainerRow {
  id: number;
  containerNumber: string;
  companyId: number;
  numberPlate: string | null;
  offloadDate: string | null;
  borderDate: string | null;
  createdAt: Date;
  transporter: string | null;
  location: string | null;
  dutyFee: number;
  status: string;
  supplierName: string | null;
  supplierCode: string | null;
}

export interface AllocatedRow extends ContainerRow {
  clearedAmount: number;
  remainingAmount: number;
  allocationStatus: AllocStatus;
}

export interface PreviewRow {
  id: number;
  containerNumber: string;
  companyId: number;
  numberPlate: string | null;
  borderDate: string | null;
  transporter: string | null;
  location: string | null;
  dutyFee: number;
  status: string;
  supplierName: string | null;
  supplierCode: string | null;
}

// ─── Container statuses treated as "offloaded / completed" ───────────────────
// These are included in the official FIFO balance allocation.
// All other statuses (OTW, At Port, etc.) go to activePreviewRows.
// DB stores "OFFLOADED" (all-caps) via storage.offloadContainer; keep both casings.
export const OFFLOADED_STATUSES = new Set(["Offloaded", "OFFLOADED", "Closed", "CLOSED", "Completed", "COMPLETED"]);

// ─── FIFO allocation ─────────────────────────────────────────────────────────
// Sort offloaded rows oldest→newest, then walk consuming clearedByPayments.
// Returns three buckets: clearedRows, partialRows (0 or 1), openRows.

// outstanding = amount currently owed to the agent (always a positive number).
// Payments made toward containers = offloadedDutyTotal - outstanding (floored at 0).
// The oldest containers are cleared first (FIFO = first-in-first-out).
export function fifoAllocate(
  offloadedRows: ContainerRow[],
  outstanding: number
): {
  clearedRows: AllocatedRow[];
  partialRows: AllocatedRow[];
  openRows: AllocatedRow[];
} {
  const sorted = [...offloadedRows].sort((a, b) => {
    const oA = a.offloadDate ?? "9999-99-99";
    const oB = b.offloadDate ?? "9999-99-99";
    if (oA !== oB) return oA < oB ? -1 : 1;
    const bA = a.borderDate ?? "9999-99-99";
    const bB = b.borderDate ?? "9999-99-99";
    if (bA !== bB) return bA < bB ? -1 : 1;
    const tA = a.createdAt instanceof Date ? a.createdAt.getTime() : 0;
    const tB = b.createdAt instanceof Date ? b.createdAt.getTime() : 0;
    if (tA !== tB) return tA - tB;
    return a.id - b.id;
  });

  const offloadedDutyTotal = sorted.reduce((s, r) => s + r.dutyFee, 0);
  // Payments made = total duty – what is still owed. Floored at 0 (can't be negative).
  let toConsume = Math.max(offloadedDutyTotal - outstanding, 0);

  const clearedRows: AllocatedRow[] = [];
  const partialRows: AllocatedRow[] = [];
  const openRows: AllocatedRow[] = [];

  for (const row of sorted) {
    if (toConsume >= row.dutyFee) {
      toConsume -= row.dutyFee;
      clearedRows.push({
        ...row,
        clearedAmount: row.dutyFee,
        remainingAmount: 0,
        allocationStatus: "Cleared",
      });
    } else if (toConsume > 0) {
      const cl = toConsume;
      toConsume = 0;
      partialRows.push({
        ...row,
        clearedAmount: cl,
        remainingAmount: row.dutyFee - cl,
        allocationStatus: "Partially Cleared",
      });
    } else {
      openRows.push({
        ...row,
        clearedAmount: 0,
        remainingAmount: row.dutyFee,
        allocationStatus: "Open",
      });
    }
  }

  return { clearedRows, partialRows, openRows };
}
