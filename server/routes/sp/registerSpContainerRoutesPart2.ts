// Extracted from ./spContainerRoutes.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  spContainerLines,
  spContainers,
  type SpOffloadCharge,
  spOffloadCharges,
  spOffloads,
  spPrepaidCharges,
  spStockMovements,
} from "@shared/schema";
import { resultRows } from "../../lib/queryResult";
import { requireSpCompany } from "./spHelpers";
import { plusMoney, toMoney } from "../../lib/money";
import { sendVoucherCorrectionRefusal } from "../../services/factory/factoryVoucherCorrection";
import { PostingValidationError } from "../../services/accounting/centralPostingEngine";
import { registerSpContainerRoutesPart3 } from "./registerSpContainerRoutesPart3";

export function registerSpContainerRoutesPart2(app: Express) {
  registerSpContainerRoutesPart3(app);

  app.get("/api/sp/containers/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;

      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ message: "Invalid id" });

      const [container] = await db
        .select()
        .from(spContainers)
        .where(and(eq(spContainers.id, id), eq(spContainers.companyId, companyId)));

      if (!container) return res.status(404).json({ message: "Container not found" });

      const lines = await db
        .select()
        .from(spContainerLines)
        .where(eq(spContainerLines.containerId, id))
        .orderBy(asc(spContainerLines.id));

      const prepaid = await db
        .select()
        .from(spPrepaidCharges)
        .where(and(eq(spPrepaidCharges.containerId, id), eq(spPrepaidCharges.companyId, companyId)))
        .orderBy(asc(spPrepaidCharges.createdAt));

      const [offload] = await db
        .select()
        .from(spOffloads)
        .where(and(eq(spOffloads.containerId, id), eq(spOffloads.companyId, companyId)));

      let offloadCharges: SpOffloadCharge[] = [];
      if (offload) {
        offloadCharges = await db.select().from(spOffloadCharges).where(eq(spOffloadCharges.offloadId, offload.id));
      }

      const movements = await db
        .select()
        .from(spStockMovements)
        .where(and(eq(spStockMovements.containerId, id), eq(spStockMovements.companyId, companyId)));

      res.json({ ...container, lines, prepaid, offload: offload || null, offloadCharges, movements });
    } catch (error: unknown) {
      if (sendVoucherCorrectionRefusal(res, error)) return;
      if (error instanceof PostingValidationError)
        return res.status(400).json({ code: error.code, message: error.message });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // GET /api/sp/containers/:id/line-preview — enriched per-line preview with alias resolution
  app.get("/api/sp/containers/:id/line-preview", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;

      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ message: "Invalid id" });

      const [container] = await db
        .select()
        .from(spContainers)
        .where(and(eq(spContainers.id, id), eq(spContainers.companyId, companyId)));

      if (!container) return res.status(404).json({ message: "Container not found" });

      const lines = await db
        .select()
        .from(spContainerLines)
        .where(eq(spContainerLines.containerId, id))
        .orderBy(asc(spContainerLines.id));

      type SpContainerAliasRow = {
        alias_code: string;
        stock_item_id: number;
        item_code: string;
        item_name: string;
      };
      const aliasResult = await db.execute(sql`
        SELECT a.alias_code, a.stock_item_id, si.code AS item_code, si.name AS item_name
        FROM stock_item_code_aliases a
        JOIN stock_items si ON si.id = a.stock_item_id
        WHERE a.company_id = ${companyId}
      `);
      const aliasMap = new Map<string, { stockItemId: number; itemCode: string; itemName: string }>();
      for (const row of resultRows<SpContainerAliasRow>(aliasResult)) {
        aliasMap.set(row.alias_code, {
          stockItemId: row.stock_item_id,
          itemCode: row.item_code,
          itemName: row.item_name,
        });
      }

      const discountFactor = 1 - toMoney(container.discountPct).toNumber() / 100;
      const totalQty = lines.reduce((s, l) => plusMoney(s, l.qty), 0);

      const enriched = lines.map((l) => {
        const alias = aliasMap.get(l.articleCode);
        const qty = toMoney(l.qty).toNumber();
        const unitRate = toMoney(l.unitRateUsd).toNumber();
        const discountedBaseRate = unitRate * discountFactor;
        return {
          id: l.id,
          articleCode: l.articleCode,
          description: l.description,
          qty,
          unitRateUsd: unitRate,
          discountedBaseRate,
          totalBaseUsd: discountedBaseRate * qty,
          lineProportion: totalQty > 0 ? qty / totalQty : 0,
          aliasResolved: !!alias,
          stockItemId: alias?.stockItemId ?? null,
          stockItemCode: alias?.itemCode ?? null,
          stockItemName: alias?.itemName ?? null,
        };
      });

      res.json({
        lines: enriched,
        totalQty,
        discountFactor,
        discountPct: container.discountPct,
        unmappedCount: enriched.filter((l) => !l.aliasResolved).length,
      });
    } catch (error: unknown) {
      if (sendVoucherCorrectionRefusal(res, error)) return;
      if (error instanceof PostingValidationError)
        return res.status(400).json({ code: error.code, message: error.message });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
