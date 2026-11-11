/**
 * Phase 5 — manual ERP PO Import Excel export, no automatic ERP writes.
 *
 * GET setup: read-only article quantities and frozen charge suggestions.
 * POST preview: exact ERP purchase costs with caller-entered rates (read-only).
 * POST download: render workbook first, then atomically pin ONE export
 * fingerprint under order->trip->financial locks. Re-downloading the same
 * content is safe; a changed rate/supplier/charge after first export is refused.
 */
import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { getFactoryAccessState, requireFactoryTabAccess } from "../../../lib/factoryAccessControl";
import { parseId } from "../../../lib/parseId";
import { resultRows } from "../../../lib/queryResult";
import { logger } from "../../../lib/logger";
import { writeWorkbook } from "../../../excelHelper";
import { buildSafeFilename } from "../../../lib/contentDisposition";
import {
  buildTripPoExport, groupFrozenTripArticles, suggestedErpPoCharges,
  TripPoExportError, tripErpContainerNumber, tripErpPoNumber,
  type TripPoExportChoice, type TripPoExportResult,
} from "./loadingDispatchPoExportModel";
import {
  findTripPoExportTx, loadPostedTripPoSourceTx, type TripPoScope,
} from "./loadingDispatchPoExportData";
import { buildTripPoImportWorkbook } from "./loadingDispatchPoExportWorkbook";

const base = "/api/factory/customer-orders/:id/loading-dispatches/:dispatchId";
const access = requireFactoryTabAccess("factory/invoicing", "hide_invoicing_loadings_tab");
const sha64 = /^[0-9a-f]{64}$/;
function fail(code: string, message: string, status = 400): never {
  throw new TripPoExportError(code, message, status);
}
function sendFailure(res: Response, error: unknown) {
  if (error instanceof TripPoExportError) {
    return res.status(error.status).json({ code: error.code, message: error.message });
  }
  if ((error as { code?: string } | null)?.code === "42P01") {
    return res.status(503).json({
      code: "TRIP_FINANCIAL_SCHEMA_PENDING",
      message: "Trip PO export is unavailable until the final TablePlus financial SQL has been installed.",
    });
  }
  logger.error("Factory dispatch ERP PO export failed", { error });
  return res.status(500).json({
    code: "TRIP_PO_EXPORT_FAILED", message: "Unable to prepare the ERP PO workbook",
  });
}
async function reqScope(req: Request): Promise<TripPoScope> {
  const state = await getFactoryAccessState(req);
  if (!state?.hasFactoryAccess || !["admin", "owner", "developer"].includes(state.role.toLowerCase())) {
    fail("TRIP_PO_EXPORT_ROLE_REQUIRED", "Only Admin, Owner or Developer may export trip supplier documents", 403);
  }
  const orderId = parseId(req.params.id);
  const dispatchId = parseId(req.params.dispatchId);
  if (orderId === null || dispatchId === null) fail("PO_ID_INVALID", "Invalid Factory loading or trip");
  return {
    companyId: state.companyId, orderId, dispatchId,
    userId: state.userId, username: req.session.username || state.userId,
  };
}
function body(req: Request): Record<string, unknown> {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    fail("PO_REQUEST_INVALID", "Enter reviewed ERP supplier and purchase prices");
  }
  return req.body as Record<string, unknown>;
}
function choiceFrom(value: unknown): TripPoExportChoice {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("PO_CHOICE_INVALID", "The PO export must include reviewed ERP rates and charges");
  }
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.rates) || !row.charges || typeof row.charges !== "object" || Array.isArray(row.charges)) {
    fail("PO_CHOICE_INVALID", "Enter an ERP purchase rate per article and review all PO charges");
  }
  return {
    supplierCode: row.supplierCode as string,
    rates: row.rates as TripPoExportChoice["rates"],
    charges: row.charges as TripPoExportChoice["charges"],
  };
}
function viewExport(p: TripPoExportResult) {
  return {
    poNumber: p.poNumber, containerNumber: p.containerNumber,
    supplierCode: p.supplierCode, sourceFingerprint: p.sourceFingerprint,
    exportFingerprint: p.exportFingerprint, revision: p.revision,
    articles: p.articles, rates: p.rates, charges: p.charges,
    goodsTotal: p.erpGoodsTotal, chargesTotal: p.erpChargesTotal,
    supplierInvoiceTotal: p.erpSupplierInvoiceTotal,
    factoryCustomerTotal: p.frozenFactoryCustomerTotal,
    rowCount: p.rows.length,
  };
}
async function assertExportMigration(tx: Parameters<typeof loadPostedTripPoSourceTx>[0]) {
  const [probe] = resultRows(await tx.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM pg_indexes
       WHERE schemaname='public' AND tablename='factory_dispatch_trip_exports'
         AND indexname='factory_dispatch_trip_exports_financial_once_uq'
    ) AS ready
  `));
  if (probe?.ready !== true) {
    fail("TRIP_PO_EXPORT_SQL_PENDING",
      "Phase 5 TablePlus unique-export guard has not been installed. Export is disabled until the final SQL handoff.", 503);
  }
}
async function ensureExistingIsSame(
  prior: Awaited<ReturnType<typeof findTripPoExportTx>>,
  source: Awaited<ReturnType<typeof loadPostedTripPoSourceTx>>,
  data: TripPoExportResult
): Promise<boolean> {
  if (!prior) return false;
  if (prior.sourceFingerprint !== source.sourceFingerprint || prior.revision !== source.revision ||
      prior.exportFingerprint !== data.exportFingerprint ||
      prior.poNumber !== data.poNumber || prior.containerNumber !== data.containerNumber ||
      prior.supplierCode !== data.supplierCode) {
    fail("TRIP_PO_ALREADY_EXPORTED_DIFFERENT_CONTENT",
      "This truck already has a different ERP PO file. Download the original values instead; changes require an approved cross-company correction.", 409);
  }
  return true;
}
export function registerFactoryLoadingDispatchPoExportRoutes(app: Express): void {
  app.get(base + "/po-export/setup", requireAuth, access, async (req, res) => {
    try {
      const scope = await reqScope(req);
      const setup = await db.transaction(async tx => {
        const source = await loadPostedTripPoSourceTx(tx, scope);
        const prior = await findTripPoExportTx(tx, scope, source.financialId);
        return {
          status: source.status, revision: source.revision, sourceFingerprint: source.sourceFingerprint,
          factoryCustomerTotal: source.customerTotal, factoryGoodsSubtotal: source.goodsSubtotal,
          poNumber: tripErpPoNumber(scope.companyId, scope.orderId, scope.dispatchId),
          containerNumber: tripErpContainerNumber(scope.companyId, scope.orderId, scope.dispatchId),
          articles: groupFrozenTripArticles(source),
          suggested: suggestedErpPoCharges(source),
          previousExport: prior,
          importInstructions: "Download the PO Import .xlsx file, then open Normal ERP → PO Import, upload, validate, select the ERP supplier, and manually import. Downloading does not create an ERP supplier balance.",
        };
      });
      res.set("Cache-Control", "private, no-store");
      return res.json(setup);
    } catch (error) { return sendFailure(res, error); }
  });

  app.post(base + "/po-export/preview", requireAuth, access, async (req, res) => {
    try {
      const scope = await reqScope(req);
      const data = body(req);
      const choice = choiceFrom(data.choice);
      const output = await db.transaction(async tx => {
        const source = await loadPostedTripPoSourceTx(tx, scope);
        if (data.expectedSourceFingerprint !== source.sourceFingerprint ||
            data.expectedRevision !== source.revision) {
          fail("TRIP_PO_SOURCE_CHANGED", "Posted trip financial source changed; refresh the export setup", 409);
        }
        const result = buildTripPoExport(source, choice);
        const prior = await findTripPoExportTx(tx, scope, source.financialId);
        await ensureExistingIsSame(prior, source, result);
        return { ...viewExport(result), alreadyGenerated: Boolean(prior) };
      });
      res.set("Cache-Control", "private, no-store");
      return res.json(output);
    } catch (error) { return sendFailure(res, error); }
  });

  app.post(base + "/po-export/download", requireAuth, access, async (req, res) => {
    try {
      const scope = await reqScope(req);
      const data = body(req);
      if (data.confirmRatesReviewed !== true || data.confirmChargesReviewed !== true) {
        fail("PO_OPERATOR_REVIEW_REQUIRED",
          "Confirm that ERP purchase rates, invoice charges and supplier code were reviewed. Factory sale prices are not automatically used.", 400);
      }
      if (typeof data.expectedSourceFingerprint !== "string" ||
          !sha64.test(data.expectedSourceFingerprint) ||
          typeof data.expectedExportFingerprint !== "string" ||
          !sha64.test(data.expectedExportFingerprint)) {
        fail("PO_PREVIEW_REQUIRED", "Preview this exact ERP PO file before downloading", 400);
      }
      const choice = choiceFrom(data.choice);
      const initial = await db.transaction(async tx => {
        const source = await loadPostedTripPoSourceTx(tx, scope);
        if (source.sourceFingerprint !== data.expectedSourceFingerprint ||
            source.revision !== data.expectedRevision) {
          fail("TRIP_PO_SOURCE_CHANGED", "Trip was updated since the workbook preview", 409);
        }
        const exportData = buildTripPoExport(source, choice);
        if (exportData.exportFingerprint !== data.expectedExportFingerprint) {
          fail("PO_PREVIEW_CHANGED", "ERP rates, charges or supplier changed; preview the file again", 409);
        }
        const prior = await findTripPoExportTx(tx, scope, source.financialId);
        await ensureExistingIsSame(prior, source, exportData);
        return { source, exportData };
      });
      // Generate the real .xlsx before recording a successful generation.
      // No long-running buffered workbook writer while holding order locks.
      const workbook = buildTripPoImportWorkbook(initial.exportData);
      const buffer = await writeWorkbook(workbook);
      if (buffer.length === 0) fail("PO_EMPTY_WORKBOOK", "Unable to create a nonempty ERP PO workbook", 500);

      const persisted = await db.transaction(async tx => {
        await assertExportMigration(tx);
        // Recheck the signed trip and exact export content under the SAME
        // order->trip->financial lock before saving the irreversible identity.
        const source = await loadPostedTripPoSourceTx(tx, scope, true);
        if (source.sourceFingerprint !== initial.source.sourceFingerprint ||
            source.revision !== initial.source.revision ||
            source.financialId !== initial.source.financialId) {
          fail("TRIP_PO_SOURCE_CHANGED", "Trip changed before ERP PO export could be recorded", 409);
        }
        const exact = buildTripPoExport(source, choice);
        if (exact.exportFingerprint !== initial.exportData.exportFingerprint) {
          fail("PO_PREVIEW_CHANGED", "ERP PO contents changed before export registration", 409);
        }
        const previous = await findTripPoExportTx(tx, scope, source.financialId);
        if (await ensureExistingIsSame(previous, source, exact)) {
          return { exportId: previous!.id, replayed: true };
        }
        const previewJson = {
          format: "ERP-PO-IMPORT-v1", version: 1,
          financialId: source.financialId, sourceFingerprint: source.sourceFingerprint,
          revision: source.revision, rates: exact.rates, charges: exact.charges,
          supplierCode: exact.supplierCode, poNumber: exact.poNumber,
          containerNumber: exact.containerNumber,
          goodsTotal: exact.erpGoodsTotal, chargesTotal: exact.erpChargesTotal,
          supplierInvoiceTotal: exact.erpSupplierInvoiceTotal,
          factoryCustomerTotal: exact.frozenFactoryCustomerTotal,
          articleCount: exact.articles.length, rowCount: exact.rows.length,
          status: "FILE_GENERATED_NOT_ERP_IMPORTED",
        };
        const [inserted] = resultRows(await tx.execute(sql`
          INSERT INTO factory_dispatch_trip_exports
            (financial_id,company_id,order_id,dispatch_id,snapshot_revision,
             source_fingerprint,export_fingerprint,target_erp_company_id,
             supplier_code,po_number,erp_container_number,preview,exported_by_user_id)
          VALUES (
            ${source.financialId},${scope.companyId},${scope.orderId},${scope.dispatchId},
            ${source.revision},${source.sourceFingerprint},${exact.exportFingerprint},NULL,
            ${exact.supplierCode},${exact.poNumber},${exact.containerNumber},
            ${JSON.stringify(previewJson)}::jsonb,${scope.userId}
          )
          RETURNING id
        `));
        const exportId = Number(inserted?.id);
        await tx.execute(sql`
          INSERT INTO factory_dispatch_financial_events
            (company_id,order_id,dispatch_id,financial_id,event_type,details,
             actor_user_id,actor_username)
          VALUES (
            ${scope.companyId},${scope.orderId},${scope.dispatchId},${source.financialId},
            'ERP_PO_FILE_GENERATED',
            ${JSON.stringify({
              exportId, exportFingerprint: exact.exportFingerprint,
              poNumber: exact.poNumber, containerNumber: exact.containerNumber,
              supplierCode: exact.supplierCode, rows: exact.rows.length,
              status: "MANUAL_ERP_IMPORT_NOT_CONFIRMED",
            })}::jsonb,${scope.userId},${scope.username}
          )
        `);
        return { exportId, replayed: false };
      });

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition",
        'attachment; filename="' + buildSafeFilename([
          "Factory_ERP_PO",initial.exportData.containerNumber,"trip",scope.dispatchId,
        ], "xlsx").replace(/[\r\n"]/g, "_") + '"');
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Factory-Export-Id", String(persisted.exportId));
      res.setHeader("X-Factory-Export-Replay", persisted.replayed ? "true" : "false");
      return res.end(buffer);
    } catch (error) {
      if (res.headersSent || res.destroyed || res.writableEnded) {
        logger.error("Factory dispatch ERP PO download interrupted", { error });
        return;
      }
      return sendFailure(res, error);
    }
  });
}
