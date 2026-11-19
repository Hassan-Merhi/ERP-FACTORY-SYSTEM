// Extracted from ./spGoldenCoastPhase5PosSaleRoutes.ts
import type { Request, Response } from "express";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { spStockMovements } from "@shared/schema";
import { db } from "../../db";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { GOLDEN_COAST_CUTOVER_DATE } from "../../services/accounting/goldenCoastPhase4CutoverFifo";
import { GOLDEN_COAST_POST_CUTOVER_FIFO_SOURCES } from "../../services/accounting/goldenCoastPhase5PosSale";
import { isGoldenCoastCompany } from "./spGoldenCoastPhase4CutoverFifoRoutes";
import { requireSpCompany } from "./spHelpers";
import {
  assertPhase4BridgePosted,
  resolvePhase5Accounts,
} from "./spGoldenCoastPhase5PosSaleRoutesActiveSubTypeAccount";

export async function handleReadiness(req: Request, res: Response): Promise<void> {
  try {
    const companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    if (!(await isGoldenCoastCompany(db, companyId))) {
      res.status(409).json({
        code: "GC_PHASE5_NOT_CONFIGURED",
        message: releaseDebtEnglish("Golden Coast account setup is not configured."),
      });
      return;
    }

    const blockers: string[] = [];
    let accounts: Awaited<ReturnType<typeof resolvePhase5Accounts>> | null = null;
    let cutoverLotCount = 0;
    try {
      accounts = await resolvePhase5Accounts(db, companyId);
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
    }
    try {
      cutoverLotCount = await assertPhase4BridgePosted(db, companyId);
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
    }

    const available = await db
      .select({
        locationId: spStockMovements.locationId,
        stockItemId: spStockMovements.stockItemId,
        articleCode: spStockMovements.articleCode,
        qtyAvailable: sql<string>`COALESCE(SUM(CAST(${spStockMovements.qtyRemaining} AS numeric)), 0)::text`,
      })
      .from(spStockMovements)
      .where(
        and(
          eq(spStockMovements.companyId, companyId),
          inArray(spStockMovements.sourceType, [...GOLDEN_COAST_POST_CUTOVER_FIFO_SOURCES]),
          sql`CAST(${spStockMovements.qtyRemaining} AS numeric) > 0`
        )
      )
      .groupBy(spStockMovements.locationId, spStockMovements.stockItemId, spStockMovements.articleCode)
      .orderBy(asc(spStockMovements.locationId), asc(spStockMovements.stockItemId));

    res.json({
      cutoverDate: GOLDEN_COAST_CUTOVER_DATE,
      cutoverLotCount,
      accounts,
      availableStock: available,
      blockers,
      canPost: blockers.length === 0,
    });
  } catch (error) {
    logger.error("Golden Coast Phase 5 readiness failed", { error });
    res.status(500).json({ message: getErrorMessage(error) });
  }
}
