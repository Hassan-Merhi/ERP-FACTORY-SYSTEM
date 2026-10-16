import type { Express } from "express";
import { errorStatus, getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { createHash } from "crypto";
import { db, pool } from "../db";
import { storage } from "../storage";
import { requireAuth, requireRole } from "../auth";
import { upload, logAudit } from "./_helpers";
import { registerBankAccountRoutes } from "./bankAccountRoutes";
import { fixedAssets, insertFixedAssetSchema } from "@shared/schema";
import { eq, and, sql, isNull } from "drizzle-orm";
import { buildAuditChanges } from "../services/audit";

import { readExcel, sheetToJson } from "../excelHelper";
import { parsePoImportSheetRows } from "./import/poImportExcelParser";
import { toMoney } from "../lib/money";

export const FIXED_ASSET_HAS_OPENING_CODE = "FIXED_ASSET_HAS_OPENING" as const;
export const FIXED_ASSET_HAS_OPENING_MESSAGE =
  "This fixed asset has an opening balance, so it cannot be deleted. Move the balance with a journal first.";
export const FIXED_ASSET_HAS_ENTRIES_CODE = "FIXED_ASSET_HAS_ENTRIES" as const;
export const FIXED_ASSET_HAS_ENTRIES_MESSAGE =
  "This fixed asset has voucher lines, so it cannot be deleted. Deactivate it instead.";

export function registerBankAssetRoutes(app: Express) {
  // Bank account master routes first (their registration order is unchanged).
  registerBankAccountRoutes(app);

  // Cash/bank revaluation is handled earlier by accountCurrencyRoutes.
  // Fixed Assets
  app.get("/api/fixed-assets", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const assets = await storage.getAllFixedAssets(companyId);

      // Compute historical cost/depreciation from voucher entries using base currency amounts.
      // COALESCE(base_debit_amount, debit_amount): historical USD cost (post-backfill); falls
      // back to debit_amount for legacy rows.
      const assetIds = assets.map((a) => a.id);
      const assetHistMap = new Map<number, { historicalCostBase: number; historicalDepreciationBase: number }>();
      if (assetIds.length > 0) {
        const histRows = await pool.query<{
          fixed_asset_id: string;
          hist_debit: string;
          hist_credit: string;
        }>(
          `SELECT ve.fixed_asset_id,
                  COALESCE(SUM(COALESCE(ve.base_debit_amount,  ve.debit_amount)::numeric),  0) AS hist_debit,
                  COALESCE(SUM(COALESCE(ve.base_credit_amount, ve.credit_amount)::numeric), 0) AS hist_credit
           FROM voucher_entries ve
           JOIN vouchers v ON ve.voucher_id = v.id
           WHERE ve.fixed_asset_id = ANY($1::int[])
             AND v.deleted_at IS NULL
             AND v.optional = false
           GROUP BY ve.fixed_asset_id`,
          [assetIds]
        );
        for (const row of histRows.rows) {
          assetHistMap.set(parseInt(row.fixed_asset_id), {
            historicalCostBase: toMoney(row.hist_debit).toNumber(),
            historicalDepreciationBase: toMoney(row.hist_credit).toNumber(),
          });
        }
      }

      // Transform to match frontend expectations (assetCode, assetName) and add historical fields
      const transformedAssets = assets.map((asset) => {
        const hist = assetHistMap.get(asset.id) || { historicalCostBase: 0, historicalDepreciationBase: 0 };
        return {
          ...asset,
          assetCode: asset.code,
          assetName: asset.name,
          historicalCostBase: hist.historicalCostBase,
          historicalDepreciationBase: hist.historicalDepreciationBase,
        };
      });
      res.json(transformedAssets);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/fixed-assets", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      // The asset always belongs to the active company; a companyId in the body
      // used to be trusted, so an asset could be created in any tenant.
      const parsed = insertFixedAssetSchema.parse({ ...req.body, companyId });

      // Check for duplicate code
      const existing = await storage.getFixedAssetByCode(parsed.code);
      if (existing) {
        return res.status(400).json({ message: "Fixed asset code already exists" });
      }

      // Validate useful life is required when depreciation method is not "None"
      if (parsed.depreciationMethod !== "None" && (!parsed.usefulLife || parsed.usefulLife <= 0)) {
        return res.status(400).json({
          message: "Useful life (years) is required and must be greater than 0 when depreciation method is not 'None'",
        });
      }

      // Wave 16 (B): the asset and its opening are audited in the same
      // transaction (the opening-balance lock refuses a non-zero opening after
      // a close).
      const asset = await db.transaction(async (tx) => {
        const [created] = await tx.insert(fixedAssets).values(parsed).returning();
        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || "unknown",
            companyId,
            action: "create",
            tableName: "fixed_assets",
            recordId: created.id,
            recordIdentifier: created.name,
            changes: buildAuditChanges(null, created, [
              "code",
              "name",
              "category",
              "purchaseDate",
              "purchaseAmount",
              "openingBalance",
            ]),
          },
          tx
        );
        return created;
      });
      res.status(201).json(asset);
    } catch (error: unknown) {
      res.status(errorStatus(error, 400)).json({ message: getErrorMessage(error) });
    }
  });

  // Phase 19 (B), PE7: Admin or Owner; a soft delete (the row stays, with its
  // code, for the history), refused while the asset has an opening or any
  // voucher line (live or deleted voucher), audited in the same transaction.
  // It was sign-in only and a hard delete with no audit.
  app.delete("/api/fixed-assets/:id", requireAuth, requireRole("Admin", "Owner"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid asset ID" });

      const outcome = await db.transaction(async (tx) => {
        const [asset] = await tx
          .select()
          .from(fixedAssets)
          .where(and(eq(fixedAssets.id, id), eq(fixedAssets.companyId, companyId), isNull(fixedAssets.deletedAt)))
          .for("update");
        if (!asset) return { status: 404 as const, body: { message: "Fixed asset not found" } };
        if (!toMoney(asset.openingBalance).isZero()) {
          return {
            status: 409 as const,
            body: { message: FIXED_ASSET_HAS_OPENING_MESSAGE, code: FIXED_ASSET_HAS_OPENING_CODE },
          };
        }
        const entryCheck = await tx.execute<{ cnt: string } & Record<string, unknown>>(
          sql`SELECT COUNT(*)::text AS cnt FROM voucher_entries WHERE fixed_asset_id = ${id}`
        );
        if (Number(entryCheck.rows[0]?.cnt ?? 0) > 0) {
          return {
            status: 409 as const,
            body: { message: FIXED_ASSET_HAS_ENTRIES_MESSAGE, code: FIXED_ASSET_HAS_ENTRIES_CODE },
          };
        }
        const [deleted] = await tx
          .update(fixedAssets)
          .set({ deletedAt: new Date(), active: false })
          .where(eq(fixedAssets.id, id))
          .returning();
        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || "unknown",
            companyId,
            action: "delete",
            tableName: "fixed_assets",
            recordId: deleted.id,
            recordIdentifier: deleted.name,
            changes: buildAuditChanges(asset, deleted, ["code", "name", "category", "purchaseAmount", "active"]),
          },
          tx
        );
        return { status: 200 as const, body: { message: "Fixed asset deleted successfully" } };
      });
      res.status(outcome.status).json(outcome.body);
    } catch (error: unknown) {
      res.status(errorStatus(error, 500)).json({ message: getErrorMessage(error) });
    }
  });

  // PO Import - Parse and Preview Excel
  app.post("/api/po-import/parse", requireAuth, upload.single("file"), async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const workbook = await readExcel(req.file.buffer);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const rawData = sheetToJson(worksheet);

      if (rawData.length === 0) {
        return res.status(400).json({ message: "Excel file is empty" });
      }

      // Calculate file hash for idempotency
      const fileHash = createHash("md5").update(req.file.buffer).digest("hex");

      // Check if file already imported
      const existingImport = await storage.getImportLogByHash(fileHash);
      if (existingImport) {
        return res.status(400).json({
          message: "This file has already been imported",
          importedAt: existingImport.createdAt,
          containerId: existingImport.containerId,
        });
      }

      // Parse and structure the data. The sheet reader is shared with the
      // Supplier Partner Excel import, so both company types read the same file
      // the same way.
      const parsed = await parsePoImportSheetRows(rawData, {
        getStockItemByCodeOrAlias: (codeOrAlias) =>
          storage.getStockItemByCodeOrAlias(codeOrAlias, req.session.currentCompanyId!),
        allStockItems: await storage.getAllStockItems(req.session.currentCompanyId!),
      });

      // Basic structural errors only (validation of item existence happens in validate step)
      if (!parsed.ok) {
        if (parsed.kind === "row-errors") {
          return res.status(400).json({ message: "Validation errors", errors: parsed.errors });
        }
        return res.status(400).json({ message: "No valid item rows found" });
      }
      const preview = parsed.preview;

      res.json({
        fileHash,
        fileName: req.file.originalname,
        rowCount: rawData.length,
        preview,
      });
    } catch (error: unknown) {
      logger.error("PO Import parse error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // PO Import - Validate data before import
}
