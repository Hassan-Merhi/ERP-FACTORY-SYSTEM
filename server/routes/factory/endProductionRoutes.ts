/**
 * End Production Routes
 *
 * Worker Matrix PDFs support explicit English/Arabic output and resolve product
 * names from frozen bale snapshots before the current catalog.
 */

import type { Express, RequestHandler } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db, pool } from "../../db";
import { factoryProductionSessions, factorySettings } from "@shared/schema";
import { parseFactoryCatalogLanguage, type FactoryCatalogLanguage } from "@shared/factoryBilingualContract";
import { eq, and, sql } from "drizzle-orm";
import { getClientDate } from "../../lib/dateUtils";
import { generateBilingualWorkerBalesPdf } from "../../lib/workerBalesBilingualPdfGenerator";
import { sendWhatsAppFileByUploadPos } from "../../services/whatsappService";

function requestedLanguage(req: import("express").Request): FactoryCatalogLanguage {
  return parseFactoryCatalogLanguage(req.body?.lang ?? req.query?.lang, "en");
}

async function fetchBaleGroupsForDate(companyId: number, date: string, language: FactoryCatalogLanguage) {
  const rows = await db.execute(sql`
    SELECT
      fb.finalized_by AS "workerId",
      fw.full_name AS "workerName",
      fb.product_id AS "productId",
      fbp.article_code AS "articleCode",
      COUNT(*)::int AS "baleCount",
      ROUND(SUM(CAST(fb.weight_kg AS numeric)), 3) AS "totalWeight",
      JSON_AGG(JSON_BUILD_OBJECT(
        'id', fb.id,
        'referenceNumber', fb.reference_number,
        'weightKg', fb.weight_kg,
        'status', fb.status,
        'workerName', fw.full_name,
        'productName', CASE
          WHEN ${language} = 'ar' THEN COALESCE(NULLIF(BTRIM(fb.product_name_ar), ''), NULLIF(BTRIM(fbp.name_ar), ''), NULLIF(BTRIM(fb.product_name), ''), NULLIF(BTRIM(fbp.name), ''), fbp.article_code)
          ELSE COALESCE(NULLIF(BTRIM(fb.product_name), ''), NULLIF(BTRIM(fbp.name), ''), NULLIF(BTRIM(fb.product_name_ar), ''), NULLIF(BTRIM(fbp.name_ar), ''), fbp.article_code)
        END,
        'articleCode', fbp.article_code
      ) ORDER BY fb.finalized_at ASC) AS "bales"
    FROM factory_bales fb
    LEFT JOIN factory_workers fw
      ON fb.finalized_by = fw.id AND fw.company_id = ${companyId}
    LEFT JOIN factory_bale_products fbp
      ON fb.product_id = fbp.id AND fbp.company_id = ${companyId}
    WHERE fb.company_id = ${companyId}
      AND fb.stock_entry_date IS NOT NULL
      AND fb.stock_entry_date = ${date}
    GROUP BY fb.finalized_by, fw.full_name, fb.product_id, fbp.article_code
    ORDER BY fw.full_name NULLS LAST, fbp.article_code NULLS LAST
  `);
  return rows.rows;
}

async function getCompanyName(companyId: number): Promise<string> {
  const res = await pool.query("SELECT name FROM companies WHERE id = $1", [companyId]);
  return res.rows?.[0]?.name ?? "";
}

async function getProductionWaGroupId(companyId: number): Promise<string | null> {
  const [settings] = await db
    .select({ extraSettings: factorySettings.extraSettings })
    .from(factorySettings)
    .where(eq(factorySettings.companyId, companyId));
  const extra = (settings?.extraSettings ?? {}) as { productionWorkerMatrixWhatsappGroupId?: string | null };
  return extra.productionWorkerMatrixWhatsappGroupId ?? null;
}

function safeFileName(companyName: string, date: string, language: FactoryCatalogLanguage): string {
  const safe = companyName
    .replace(/[^a-zA-Z0-9 \-_.]/g, "")
    .trim()
    .slice(0, 60);
  return `Worker Matrix ${safe} ${date} ${language.toUpperCase()}.pdf`;
}

function caption(companyName: string, date: string, language: FactoryCatalogLanguage): string {
  return language === "ar"
    ? `تقرير بالات العمال — ${companyName} — ${date}`
    : `Worker Matrix — ${companyName} — ${date}`;
}

export function registerEndProductionRoutes(app: Express, requireAuth: RequestHandler) {
  app.get(
    "/api/factory/stock-entry/production-session",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const companyId = req.session?.factoryCompanyId || req.session?.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const date = (req.query.date as string) || getClientDate(req);
        const [session] = await db
          .select()
          .from(factoryProductionSessions)
          .where(
            and(eq(factoryProductionSessions.companyId, companyId), eq(factoryProductionSessions.sessionDate, date))
          );
        res.json(session ?? null);
      } catch (err: unknown) {
        logger.error("[endProduction] GET session error:", { error: err });
        res.status(500).json({ message: getErrorMessage(err) });
      }
    }
  );

  app.post(
    "/api/factory/stock-entry/end-production",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const companyId = req.session?.factoryCompanyId || req.session?.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const language = requestedLanguage(req);
        const date = (req.body?.date as string) || getClientDate(req);
        const endedBy = req.session?.username ?? req.session?.userId ?? null;
        const [existing] = await db
          .select()
          .from(factoryProductionSessions)
          .where(
            and(eq(factoryProductionSessions.companyId, companyId), eq(factoryProductionSessions.sessionDate, date))
          );
        if (existing?.productionEndedAt) {
          return res.status(409).json({ message: "Production already ended for this date.", session: existing });
        }

        const groups = await fetchBaleGroupsForDate(companyId, date, language);
        if (!groups.length) return res.status(404).json({ message: "No stock entry session found for today." });
        const chatId = await getProductionWaGroupId(companyId);
        if (!chatId) return res.status(400).json({ message: "No production WhatsApp group configured." });

        const companyName = await getCompanyName(companyId);
        const pdfBuffer = await generateBilingualWorkerBalesPdf(groups, date, companyName, language);
        const fileName = safeFileName(companyName, date, language);
        const waResult = await sendWhatsAppFileByUploadPos(
          chatId,
          pdfBuffer,
          fileName,
          caption(companyName, date, language),
          "application/pdf"
        );
        if (!waResult?.success) {
          return res.status(502).json({
            message: `Worker Matrix WhatsApp send failed. Production was not ended. ${waResult?.error ?? ""}`.trim(),
          });
        }

        const now = new Date();
        const [session] = await db
          .insert(factoryProductionSessions)
          .values({
            companyId,
            sessionDate: date,
            productionEndedAt: now,
            productionEndedBy: endedBy ? String(endedBy) : null,
            workerMatrixWhatsappSentAt: now,
            workerMatrixWhatsappMessageId: null,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [factoryProductionSessions.companyId, factoryProductionSessions.sessionDate],
            set: {
              productionEndedAt: now,
              productionEndedBy: endedBy ? String(endedBy) : null,
              workerMatrixWhatsappSentAt: now,
              workerMatrixWhatsappMessageId: null,
              updatedAt: now,
            },
          })
          .returning();
        res.json({
          message: "Production ended. Worker Matrix PDF sent to WhatsApp.",
          language,
          session,
          whatsapp: waResult,
        });
      } catch (err: unknown) {
        logger.error("[endProduction] POST end-production error:", { error: err });
        res.status(500).json({ message: getErrorMessage(err) });
      }
    }
  );

  app.post(
    "/api/factory/bales/send-worker-pdf-whatsapp",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const companyId = req.session?.factoryCompanyId || req.session?.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const language = requestedLanguage(req);
        const date = (req.body?.date as string) || getClientDate(req);
        const groups = await fetchBaleGroupsForDate(companyId, date, language);
        if (!groups.length) return res.status(404).json({ message: "No stock entry data found for the given date." });
        const chatId = await getProductionWaGroupId(companyId);
        if (!chatId) return res.status(400).json({ message: "No production WhatsApp group configured." });

        const companyName = await getCompanyName(companyId);
        const pdfBuffer = await generateBilingualWorkerBalesPdf(groups, date, companyName, language);
        const fileName = safeFileName(companyName, date, language);
        const waResult = await sendWhatsAppFileByUploadPos(
          chatId,
          pdfBuffer,
          fileName,
          caption(companyName, date, language),
          "application/pdf"
        );
        if (!waResult?.success) {
          return res.status(502).json({ message: `WhatsApp send failed. ${waResult?.error ?? ""}`.trim() });
        }
        res.json({ message: "Worker Matrix PDF sent to WhatsApp.", language, whatsapp: waResult });
      } catch (err: unknown) {
        logger.error("[endProduction] POST manual send error:", { error: err });
        res.status(500).json({ message: getErrorMessage(err) });
      }
    }
  );
}
