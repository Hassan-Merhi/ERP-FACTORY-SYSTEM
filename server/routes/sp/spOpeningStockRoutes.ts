import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { sql, eq, and, isNull } from "drizzle-orm";
import { locations, spStockMovements } from "@shared/schema";
import { adjustSpInventoryAtomic, respondToSpInventoryIntegrityError } from "../../services/sp/spInventoryIntegrity";
import { SP_RELEASE_CURRENCY, SP_RELEASE_EXCHANGE_RATE } from "../../services/sp/spReleasePolicy";
import { requireSpCompany, getSpAccount } from "./spHelpers";
import type Decimal from "decimal.js";
import { parseMoneyInput, toMoney } from "../../lib/money";
import { postFactoryVoucherTx } from "../../services/factory/factoryVoucherPosting";

/** A request number as parseFloat read it, exact (0 when it does not parse). */
const num = (value: unknown): Decimal =>
  parseMoneyInput(typeof value === "number" ? value : String(value ?? "0")) ?? toMoney(0);
import { resultRows } from "../../lib/queryResult";

// ── Opening Stock ─────────────────────────────────────────────────────────

export function registerSpOpeningStockRoutes(app: Express) {
  app.get("/api/sp/opening-stock", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;
      const rows = await db.execute(
        sql`SELECT * FROM sp_stock_movements WHERE company_id = ${companyId} AND source_type = 'opening' ORDER BY created_at DESC`
      );
      res.json(resultRows(rows));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/sp/opening-stock", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;

      const { articleCode, stockItemId, qty, baseUnitCostUsd, landedUnitCostUsd, finalUnitCostUsd, locationId, notes } =
        req.body;

      if (!articleCode) return res.status(400).json({ message: "articleCode required" });
      const parsedStockItemId = Number(stockItemId);
      if (!Number.isInteger(parsedStockItemId) || parsedStockItemId <= 0) {
        return res.status(400).json({
          code: "SP_INVENTORY_LINK_REQUIRED",
          message: "stockItemId is required so opening stock and ERP inventory remain synchronized",
        });
      }

      // Phase 22 (C), PE13: exact Decimal money (was parseFloat arithmetic).
      const qtyNum = num(qty);
      if (qtyNum.lessThanOrEqualTo(0)) return res.status(400).json({ message: "qty must be > 0" });
      const baseUC = num(baseUnitCostUsd);
      const landUC = num(landedUnitCostUsd);
      const finalUC = num(finalUnitCostUsd);
      if (finalUC.lessThanOrEqualTo(0)) return res.status(400).json({ message: "finalUnitCostUsd must be > 0" });

      const stockAcct = await getSpAccount(companyId, "sp_stock");
      const costClrAcct = await getSpAccount(companyId, "sp_cost_clearing");
      const opnBalAcct = await getSpAccount(companyId, "sp_opnbal");
      if (!stockAcct || !costClrAcct || !opnBalAcct) {
        return res.status(400).json({ message: "SP accounts not configured. Run Setup first." });
      }

      let locId: number | null = locationId ? parseInt(locationId) : null;
      if (!locId) {
        const locs = await db
          .select()
          .from(locations)
          .where(and(eq(locations.companyId, companyId), isNull(locations.deletedAt)));
        if (locs.length > 0) locId = locs[0].id;
      }
      if (!locId) {
        return res.status(400).json({
          code: "SP_INVENTORY_LINK_REQUIRED",
          message: "An active Supplier Partner location is required before opening stock can be posted",
        });
      }

      // Posted at cents; the opening-equity line takes the exact difference.
      const finalTotal = qtyNum.times(finalUC).toDecimalPlaces(2);
      const baseTotal = qtyNum.times(baseUC).toDecimalPlaces(2);
      const landTotal = qtyNum.times(landUC);
      const openingBalanceTotal = finalTotal.minus(baseTotal);

      const result = await db.transaction(async (tx) => {
        const [movement] = await tx
          .insert(spStockMovements)
          .values({
            companyId,
            sourceType: "opening",
            articleCode,
            description: notes || null,
            stockItemId: parsedStockItemId,
            locationId: locId,
            qtyIn: qtyNum.toFixed(),
            qtyRemaining: qtyNum.toFixed(),
            baseUnitCostUsd: baseUC.toFixed(),
            landedUnitCostUsd: landUC.toFixed(),
            finalUnitCostUsd: finalUC.toFixed(),
          })
          .returning();

        await adjustSpInventoryAtomic(tx, {
          companyId,
          locationId: locId,
          stockItemId: parsedStockItemId,
          deltaQty: qtyNum.toNumber(),
          incomingRate: finalUC.toNumber(),
          context: `SP opening stock ${articleCode} movement #${movement.id}`,
          sourceVoucherType: "SP_OPENING_STOCK",
          sourceVoucherId: movement.id,
        });

        // Dr SP-STOCK = finalTotal / Cr SP-COSTCLR = baseTotal (cleared to supplier
        // payable when sold) / the exact difference to opening equity (this always
        // balances, including historical imports whose final cost contains an
        // adjustment beyond the declared landed cost). Phase 22 (C): through the
        // engine with the movement's identity; SP-OPNSTK- number kept (generation suffix).
        const { voucher } = await postFactoryVoucherTx(tx, {
          companyId,
          voucherNumber: (generation) => `SP-OPNSTK-${movement.id}-${generation}`,
          voucherDate: new Date().toISOString().slice(0, 10),
          description: `Opening stock — ${articleCode} (${qtyNum} units)`,
          currency: SP_RELEASE_CURRENCY,
          fxRateToUsd: SP_RELEASE_EXCHANGE_RATE,
          sourceModule: "SP",
          source: { sourceType: "sp-opening-stock", sourceId: `${companyId}:${movement.id}`, phase: "voucher" },
          lines: [
            {
              ledgerAccountId: stockAcct.id,
              debit: finalTotal,
              narration: `Opening stock — ${articleCode} — ${qtyNum} units @ $${finalUC} (final)`,
            },
            ...(baseTotal.greaterThan(0)
              ? [
                  {
                    ledgerAccountId: costClrAcct.id,
                    credit: baseTotal,
                    narration: `Opening stock base cost clearing — ${articleCode}`,
                  },
                ]
              : []),
            ...(openingBalanceTotal.isZero()
              ? []
              : [
                  {
                    ledgerAccountId: opnBalAcct.id,
                    debit: openingBalanceTotal.isNegative() ? openingBalanceTotal.abs() : 0,
                    credit: openingBalanceTotal.isNegative() ? 0 : openingBalanceTotal,
                    narration: `Opening stock landed/adjustment clearing — ${articleCode} (declared landed $${landTotal})`,
                  },
                ]),
          ],
        });

        return { movement, voucherId: voucher.id };
      });

      res.json(result);
    } catch (error: unknown) {
      if (respondToSpInventoryIntegrityError(res, error)) return;
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
