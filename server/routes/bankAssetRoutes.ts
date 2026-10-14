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
import { parseMoneyInput, toMoney } from "../lib/money";

export const FIXED_ASSET_HAS_OPENING_CODE = "FIXED_ASSET_HAS_OPENING" as const;
export const FIXED_ASSET_HAS_OPENING_MESSAGE =
  "This fixed asset has an opening balance, so it cannot be deleted. Move the balance with a journal first.";
export const FIXED_ASSET_HAS_ENTRIES_CODE = "FIXED_ASSET_HAS_ENTRIES" as const;
export const FIXED_ASSET_HAS_ENTRIES_MESSAGE =
  "This fixed asset has voucher lines, so it cannot be deleted. Deactivate it instead.";

/**
 * The container-import spreadsheet, as this route reads it.
 *
 * `sheetToJson` yields one record per row keyed by header name, with each cell
 * left as the workbook held it — text, a number, or a boolean. The parsing below
 * previously carried these rows as `any[]`, so a renamed column or a cell of an
 * unexpected type reached the purchase-order preview as `undefined` rather than
 * as a row error the importer could report.
 */
type ImportSheetRow = Record<string, unknown>;

/** One item line parsed out of the sheet, before container grouping. */
interface ParsedItemRow {
  rowNum: number;
  poNumber: string;
  containerNumber: string;
  supplierCode: string;
  barcode: string | null;
  stockItemId: number | null;
  itemName: string;
  quantity: number;
  rate: number;
  lineTotal: number;
  currency: string;
  freight: number;
  surcharge: number;
  fumigation: number;
  discount: number;
  documentCharges: number;
}

/** One charge line parsed out of the sheet, when charges arrive as their own rows. */
interface ParsedChargeRow {
  rowNum: number;
  chargeType: string;
  amount: number;
  containerNumber: string;
}

/** Item lines grouped by container, and by PO number within each container. */
interface ContainerGroup {
  containerNumber: string;
  supplierCode: string;
  items: ParsedItemRow[];
  pos: Map<string, ParsedItemRow[]>;
}

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

      // Parse and structure the data
      const rows = rawData;
      const errors: string[] = [];
      const itemRows: ParsedItemRow[] = [];
      const chargeRows: ParsedChargeRow[] = [];

      // Get all stock items for barcode/name lookup
      const allStockItems = await storage.getAllStockItems(req.session.currentCompanyId!);

      // Helper function to find column value with flexible naming. The value is
      // returned as the sheet parser yielded it — a cell may be text, a number or
      // a boolean — because several call sites below test it for truthiness, where
      // a numeric 0 and the string "0" behave differently.
      const getColumnValue = (row: ImportSheetRow, ...possibleNames: string[]): unknown => {
        for (const name of possibleNames) {
          if (row[name] !== undefined && row[name] !== null && row[name] !== "") {
            return row[name];
          }
        }
        return undefined;
      };

      /** A column as text, or "" when absent. */
      const columnText = (row: ImportSheetRow, ...possibleNames: string[]): string => {
        const value = getColumnValue(row, ...possibleNames);
        return value === undefined ? "" : String(value);
      };

      /** A column as a number read the way parseFloat reads it; NaN when it does not parse. */
      const columnNumber = (row: ImportSheetRow, ...possibleNames: string[]): number =>
        parseMoneyInput(String(getColumnValue(row, ...possibleNames) || "0"))?.toNumber() ?? NaN;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 2;

        // Check if it's a charge row or item row
        const chargeType = getColumnValue(row, "Charge_Type", "Charge Type");
        const chargeAmount = getColumnValue(row, "Charge_Amount", "Charge Amount");
        if (chargeType && chargeAmount) {
          chargeRows.push({
            rowNum,
            chargeType: String(chargeType),
            amount: parseMoneyInput(String(chargeAmount))?.toNumber() ?? NaN,
            containerNumber: columnText(row, "Container_Number", "Container Number"),
          });
        } else if (
          getColumnValue(row, "Item_Barcode", "Item Barcode") ||
          getColumnValue(row, "Item_Name", "Item Name")
        ) {
          let stockItem = null;
          const itemBarcode = columnText(row, "Item_Barcode", "Item Barcode");
          const itemNameValue = columnText(row, "Item_Name", "Item Name");
          let itemName = itemNameValue;

          // Try to find stock item by code/alias or name (for preview purposes only - validation happens in validate step)
          if (itemBarcode) {
            stockItem = await storage.getStockItemByCodeOrAlias(itemBarcode, req.session.currentCompanyId!);
            if (stockItem) {
              itemName = stockItem.name;
            }
          } else if (itemNameValue) {
            stockItem = allStockItems.find((item) => item.name === itemNameValue);
          }

          const quantity = columnNumber(row, "Quantity");
          const rate = columnNumber(row, "Rate");

          if (quantity === 0 || isNaN(quantity)) {
            errors.push(`Row ${rowNum}: Quantity must be a non-zero number (negative quantities are allowed)`);
            continue;
          }

          if (rate === undefined || rate < 0) {
            errors.push(`Row ${rowNum}: Rate must be non-negative`);
            continue;
          }

          itemRows.push({
            rowNum,
            poNumber: columnText(row, "PO_Number", "PO Number"),
            containerNumber: columnText(row, "Container_Number", "Container Number"),
            supplierCode: columnText(row, "Supplier_Code", "Supplier Code"),
            barcode: itemBarcode || null,
            stockItemId: stockItem?.id || null,
            itemName: itemName,
            quantity: quantity,
            rate: rate,
            lineTotal: quantity * rate,
            currency: columnText(row, "Currency") || "USD",
            freight: columnNumber(row, "Freight"),
            surcharge: columnNumber(row, "Surcharge"),
            fumigation: columnNumber(row, "Fumigation"),
            discount: columnNumber(row, "Discount"),
            documentCharges: columnNumber(row, "Document_Charges", "Document Charges"),
          });
        }
      }

      // Basic structural errors only (validation of item existence happens in validate step)
      if (errors.length > 0) {
        return res.status(400).json({ message: "Validation errors", errors });
      }

      if (itemRows.length === 0) {
        return res.status(400).json({ message: "No valid item rows found" });
      }

      // Group by container
      const containerGroups = itemRows.reduce<Record<string, ContainerGroup>>((acc, row) => {
        if (!acc[row.containerNumber]) {
          acc[row.containerNumber] = {
            containerNumber: row.containerNumber,
            supplierCode: row.supplierCode,
            items: [],
            pos: new Map(),
          };
        }

        const container = acc[row.containerNumber];
        container.items.push(row);

        if (!container.pos.has(row.poNumber)) {
          container.pos.set(row.poNumber, []);
        }
        container.pos.get(row.poNumber)!.push(row);

        return acc;
      }, {});

      // Calculate container totals
      const preview = Object.values(containerGroups).map((container) => {
        const itemsTotal = container.items.reduce((sum, item) => sum + item.lineTotal, 0);

        // Get charges from rows or aggregate from columns
        const charges = {
          freight: 0,
          surcharge: 0,
          fumigation: 0,
          discount: 0,
          documentCharges: 0,
        };

        // Check if charges are in separate rows
        const containerCharges = chargeRows.filter((c) => c.containerNumber === container.containerNumber);
        if (containerCharges.length > 0) {
          containerCharges.forEach((charge) => {
            const chargeType = (charge.chargeType || "").toLowerCase().replace(/[_\s]/g, "");
            if (chargeType === "freight") charges.freight = charge.amount;
            else if (chargeType === "surcharge") charges.surcharge = charge.amount;
            else if (chargeType === "fumigation") charges.fumigation = charge.amount;
            else if (chargeType === "discount") charges.discount = charge.amount;
            else if (chargeType.includes("document")) charges.documentCharges = charge.amount;
          });
        } else {
          // Aggregate from item row columns
          container.items.forEach((item) => {
            charges.freight += item.freight;
            charges.surcharge += item.surcharge;
            charges.fumigation += item.fumigation;
            charges.discount += item.discount;
            charges.documentCharges += item.documentCharges;
          });
        }

        const chargesTotal =
          charges.freight + charges.surcharge + charges.fumigation + charges.documentCharges - charges.discount;
        const grandTotal = itemsTotal + chargesTotal;

        return {
          containerNumber: container.containerNumber,
          supplierCode: container.supplierCode,
          itemsCount: container.items.length,
          posCount: container.pos.size,
          itemsTotal,
          charges,
          chargesTotal,
          grandTotal,
          items: container.items,
          pos: Array.from(container.pos.keys()),
        };
      });

      res.json({
        fileHash,
        fileName: req.file.originalname,
        rowCount: rows.length,
        preview,
      });
    } catch (error: unknown) {
      logger.error("PO Import parse error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // PO Import - Validate data before import
}
