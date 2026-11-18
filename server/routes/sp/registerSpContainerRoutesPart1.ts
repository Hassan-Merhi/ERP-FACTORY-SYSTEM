// Extracted from ./spContainerRoutes.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { ledgerAccounts, spContainerLines, spContainers } from "@shared/schema";
import { getSpAccount, parseNum, requireSpCompany } from "./spHelpers";
import { parseMoneyInput, toMoney } from "../../lib/money";
import { postFactoryPartyLineVoucherTx } from "../../services/factory/factoryVoucherPosting";
import { sendVoucherCorrectionRefusal } from "../../services/factory/factoryVoucherCorrection";
import { PostingValidationError } from "../../services/accounting/centralPostingEngine";
import { logger } from "../../lib/logger";
import { storage } from "../../storage";
import { spreadsheetUpload } from "../_helpers";
import { readExcel, sheetToJson } from "../../excelHelper";
import { parsePoImportSheetRows } from "../import/poImportExcelParser";
import { supplierService } from "../suppliers/supplierService";
import { buildSpContainerExcelImport, SP_CONTAINER_EXCEL_IMPORT_PARSE_PATH } from "@shared/spContainerExcelImport";
import { FRESH_START_OTW_SOURCE_NAME } from "@shared/goldenCoastOtwSource";
import { isFreshStartOtwCompany, validateSpExcelImport } from "./spContainerRoutesValidateSpExcelImport";

export function registerSpContainerRoutesPart1(app: Express) {
  app.get("/api/sp/containers", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;

      const containers = await db
        .select()
        .from(spContainers)
        .where(eq(spContainers.companyId, companyId))
        .orderBy(desc(spContainers.createdAt));

      const lines = await db.select().from(spContainerLines).where(eq(spContainerLines.companyId, companyId));

      const result = containers.map((c) => ({
        ...c,
        lines: lines.filter((l) => l.containerId === c.id),
        totalQty: lines.filter((l) => l.containerId === c.id).reduce((s, l) => s + parseNum(l.qty), 0),
      }));

      res.json(result);
    } catch (error: unknown) {
      if (sendVoucherCorrectionRefusal(res, error)) return;
      if (error instanceof PostingValidationError)
        return res.status(400).json({ code: error.code, message: error.message });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/sp/containers", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;

      const {
        importSource,
        supplierId,
        supplierName: requestedSupplierName,
        containerNumber,
        invoiceNumber,
        invoiceDate,
        invoiceTotalUsd,
        discountPct,
        freightEstimateUsd,
        surchargeUsd,
        fumigationUsd,
        documentChargesUsd,
        notes,
        lines,
        otwAccountId,
        otwClearingAccountId,
      } = req.body;

      if (!invoiceNumber || !invoiceDate || (importSource !== "excel" && !requestedSupplierName)) {
        return res.status(400).json({ message: "supplierName, invoiceNumber, invoiceDate are required" });
      }
      const freshStartOtw = importSource === "excel" && (await isFreshStartOtwCompany(companyId));
      const supplierName = freshStartOtw ? FRESH_START_OTW_SOURCE_NAME : requestedSupplierName;

      if (importSource === "excel" && (otwAccountId || otwClearingAccountId)) {
        return res.status(400).json({
          message: "Excel imports must use the Supplier Payable company\u0027s configured Goods OTW accounts.",
        });
      }
      if (importSource === "excel") {
        const validation = await validateSpExcelImport(companyId, req.body, db, true, freshStartOtw);
        if (validation.errors.length)
          return res
            .status(400)
            .json({ code: "SP_EXCEL_IMPORT_INVALID", message: validation.errors.join("; "), ...validation });
      }

      let otwAcct = await getSpAccount(companyId, "sp_goods_otw");
      let otwClrAcct = await getSpAccount(companyId, "sp_otw_clearing");
      if (!otwAcct || !otwClrAcct) {
        return res.status(400).json({ message: "Chart of accounts not set up. Run /api/sp/setup first." });
      }

      // Allow optional override accounts — validate they belong to this company
      if (otwAccountId) {
        const [customOtw] = await db
          .select()
          .from(ledgerAccounts)
          .where(
            and(
              eq(ledgerAccounts.id, parseInt(otwAccountId)),
              eq(ledgerAccounts.companyId, companyId),
              isNull(ledgerAccounts.deletedAt)
            )
          );
        if (!customOtw) return res.status(400).json({ message: "Goods OTW account not found for this company" });
        otwAcct = customOtw;
      }
      if (otwClearingAccountId) {
        const [customOtwClr] = await db
          .select()
          .from(ledgerAccounts)
          .where(
            and(
              eq(ledgerAccounts.id, parseInt(otwClearingAccountId)),
              eq(ledgerAccounts.companyId, companyId),
              isNull(ledgerAccounts.deletedAt)
            )
          );
        if (!customOtwClr) return res.status(400).json({ message: "OTW Clearing account not found for this company" });
        otwClrAcct = customOtwClr;
      }

      const totalUsd = (parseMoneyInput(invoiceTotalUsd) ?? toMoney(0)).toDecimalPlaces(2);
      const supplierIdNum = freshStartOtw ? null : supplierId ? parseInt(String(supplierId)) : null;

      const result = await db.transaction(async (tx) => {
        if (importSource === "excel") {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(${companyId}, 20831016)`);
          const recheck = await validateSpExcelImport(companyId, req.body, tx, false, freshStartOtw);
          if (recheck.errors.length) {
            const error = new Error(recheck.errors.join("; ")) as Error & { code?: string };
            error.code = "SP_EXCEL_IMPORT_INVALID";
            throw error;
          }
        }
        const [container] = await tx
          .insert(spContainers)
          .values({
            companyId,
            supplierId: supplierIdNum,
            supplierName: supplierName,
            containerNumber: containerNumber || null,
            invoiceNumber,
            invoiceDate,
            invoiceTotalUsd: totalUsd.toFixed(2),
            discountPct: String(parseNum(discountPct)),
            freightEstimateUsd: String(parseNum(freightEstimateUsd)),
            surchargeUsd: String(parseNum(surchargeUsd)),
            fumigationUsd: String(parseNum(fumigationUsd)),
            documentChargesUsd: String(parseNum(documentChargesUsd)),
            notes: notes || null,
            status: "open",
          })
          .returning();

        // Insert lines
        if (lines && lines.length > 0) {
          await tx.insert(spContainerLines).values(
            lines.map((l: Record<string, unknown>) => ({
              containerId: container.id,
              companyId,
              articleCode: l.articleCode,
              description: l.description || null,
              qty: String(parseNum(l.qty)),
              unitRateUsd: String(parseNum(l.unitRateUsd)),
              stockItemId: l.stockItemId || null,
            }))
          );
        }

        // Voucher: Dr Goods OTW / Cr Goods OTW Clearing
        if (totalUsd.greaterThan(0)) {
          // Phase 22 (C): identity, Decimal, deterministic SP-OTW- number (read as
          // identity by the SP lists). The clearing line carries the supplier as
          // party, so it is posted by the party-line writer (see factoryVoucherPosting).
          const { voucherId } = await postFactoryPartyLineVoucherTx(tx, {
            companyId,
            voucherNumber: (generation) => `SP-OTW-${container.id}-${generation}`,
            voucherDate: invoiceDate,
            description: `Goods OTW: ${supplierName} — Invoice ${invoiceNumber}`,
            sourceModule: "SP",
            source: { sourceType: "sp-container-otw", sourceId: `${companyId}:${container.id}`, phase: "voucher" },
            lines: [
              {
                ledgerAccountId: otwAcct.id,
                debit: totalUsd,
                narration: `Goods OTW — ${supplierName} inv ${invoiceNumber}`,
              },
              {
                ledgerAccountId: otwClrAcct.id,
                supplierId: supplierIdNum,
                credit: totalUsd,
                narration: `OTW Clearing — ${supplierName} inv ${invoiceNumber}`,
              },
            ],
          });
          const voucher = { id: voucherId };
          await tx.update(spContainers).set({ goodsOtwVoucherId: voucher.id }).where(eq(spContainers.id, container.id));
        }

        return container;
      });

      res.json(result);
    } catch (error: unknown) {
      if ((error as { code?: string })?.code === "SP_EXCEL_IMPORT_INVALID") {
        return res.status(409).json({ code: "SP_EXCEL_IMPORT_INVALID", message: getErrorMessage(error) });
      }
      if (sendVoucherCorrectionRefusal(res, error)) return;
      if (error instanceof PostingValidationError)
        return res.status(400).json({ code: error.code, message: error.message });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // POST /api/sp/containers/import-excel/parse — read the ERP "PO Import" Excel
  // (the file every ERP company imports for a container) and return the Supplier
  // Partner container it describes: supplier, article lines, items total, charges,
  // discount %, freight estimate and the Goods OTW total. Nothing is written; the
  // dialog fills its form from this and POST /api/sp/containers posts the voucher.
  app.post(SP_CONTAINER_EXCEL_IMPORT_PARSE_PATH, requireAuth, spreadsheetUpload.single("file"), async (req, res) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;

      if (!req.file) return res.status(400).json({ message: "No file uploaded" });

      const workbook = await readExcel(req.file.buffer);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const rawData = sheetToJson(worksheet);
      if (rawData.length === 0) return res.status(400).json({ message: "Excel file is empty" });

      // Same reader as POST /api/po-import/parse, so a barcode, an alias, a charge
      // row and a container total mean exactly what they mean for an ERP company.
      const parsed = await parsePoImportSheetRows(rawData, {
        getStockItemByCodeOrAlias: (codeOrAlias) => storage.getStockItemByCodeOrAlias(codeOrAlias, companyId),
        allStockItems: await storage.getAllStockItems(companyId),
      });
      if (!parsed.ok) {
        if (parsed.kind === "row-errors") {
          return res.status(400).json({ message: "Validation errors", errors: parsed.errors });
        }
        return res.status(400).json({ message: "No valid item rows found" });
      }

      const freshStartOtwSource = await isFreshStartOtwCompany(companyId);
      const suppliers = freshStartOtwSource ? [] : await supplierService.list(companyId, "");
      const supplierOptions = suppliers.map((supplier) => ({
        id: supplier.id,
        legalName: supplier.legalName,
        code: supplier.code,
      }));
      const containers = parsed.preview.map((container) => buildSpContainerExcelImport(container, supplierOptions));

      res.json({ fileName: req.file.originalname, rowCount: rawData.length, freshStartOtwSource, containers });
    } catch (error: unknown) {
      logger.error("SP container Excel import parse failed", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // The Validate button is a read-only preflight. Import repeats this check
  // inside its transaction before posting Supplier Payable accounting.
  app.post("/api/sp/containers/import-excel/validate", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;
      const freshStartOtw = await isFreshStartOtwCompany(companyId);
      res.json(await validateSpExcelImport(companyId, req.body, db, true, freshStartOtw));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
