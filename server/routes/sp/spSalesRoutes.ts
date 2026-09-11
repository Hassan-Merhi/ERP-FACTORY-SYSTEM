import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { sql, eq, and, gt, isNull, desc, asc } from "drizzle-orm";
import {
  ledgerAccounts,
  vouchers,
  voucherEntries,
  bankAccounts,
  spStockMovements,
  spSales,
  spSaleLines,
  stockItemCodeAliases,
} from "@shared/schema";
import { adjustSpInventoryAtomic, respondToSpInventoryIntegrityError } from "../../services/sp/spInventoryIntegrity";
import { SP_RELEASE_CURRENCY, SP_RELEASE_EXCHANGE_RATE } from "../../services/sp/spReleasePolicy";
import { requireSpCompany, getSpAccount, parseNum } from "./spHelpers";
import { resultRows } from "../../lib/queryResult";

type SpSaleLotRow = {
  id: number;
  article_code: string;
  description: string | null;
  stock_item_id: number | null;
} & Record<string, unknown>;

type SpSalePostedLine = {
  movementId: number;
  articleCode: string;
  description: string | null;
  stockItemId: number | null;
  qtySold: number;
  salePricePerUnit: number;
  baseUnitCostUsd: number;
  landedUnitCostUsd: number;
  finalUnitCostUsd: number;
  saleTotal: number;
  baseTotal: number;
  finalTotal: number;
};

// ── Sales + Stock Movements ───────────────────────────────────────────────────

export function registerSpSalesRoutes(app: Express) {
  app.get("/api/sp/sales", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;

      const sales = await db
        .select()
        .from(spSales)
        .where(eq(spSales.companyId, companyId))
        .orderBy(desc(spSales.createdAt));

      const lines = await db.select().from(spSaleLines).where(eq(spSaleLines.companyId, companyId));

      const result = sales.map((s) => ({
        ...s,
        lines: lines.filter((l) => l.saleId === s.id),
      }));

      res.json(result);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/sp/sales", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;

      const { saleDate, customerName, saleLines, bankAccountId, paymentAccountType, paymentAccountId, notes } =
        req.body;

      if (!saleDate || !customerName || !Array.isArray(saleLines) || saleLines.length === 0) {
        return res.status(400).json({ message: "saleDate, customerName, saleLines required" });
      }

      // The sale voucher now posts exactly two lines — Dr selected Cash/Bank and
      // Cr Supplier Cash Payable, both = totalSalePrice — so a settlement account
      // is mandatory; without it the voucher would post an unbalanced single credit line.
      // paymentAccountType/paymentAccountId is the current (cash-or-bank) contract,
      // same as normal ERP POS; bankAccountId is kept as a legacy fallback for
      // any older callers that only ever posted to a bank account.
      const resolvedAccountId = paymentAccountId ?? bankAccountId;
      const resolvedAccountType: "cash" | "bank" = paymentAccountType === "cash" ? "cash" : "bank";
      if (!resolvedAccountId) {
        return res
          .status(400)
          .json({ message: "A cash or bank account is required to record where the sale cash was collected" });
      }

      // Validate the settlement account belongs to this company, and is the
      // right kind of account for the selected type.
      let settlementBankAccountId: number | null = null;
      let settlementLedgerAccountId: number | null = null;
      if (resolvedAccountType === "cash") {
        const [cashLedger] = await db
          .select({ id: ledgerAccounts.id, accountType: ledgerAccounts.accountType })
          .from(ledgerAccounts)
          .where(
            and(
              eq(ledgerAccounts.id, parseInt(resolvedAccountId)),
              eq(ledgerAccounts.companyId, companyId),
              isNull(ledgerAccounts.deletedAt)
            )
          )
          .limit(1);
        if (!cashLedger || cashLedger.accountType !== "Cash") {
          return res.status(400).json({ message: "Invalid cash account — account not found for this company" });
        }
        settlementLedgerAccountId = cashLedger.id;
      } else {
        const [ba] = await db
          .select({ id: bankAccounts.id, companyId: bankAccounts.companyId })
          .from(bankAccounts)
          .where(and(eq(bankAccounts.id, parseInt(resolvedAccountId)), eq(bankAccounts.companyId, companyId)))
          .limit(1);
        if (!ba) {
          return res.status(400).json({ message: "Invalid bank account — account not found for this company" });
        }
        settlementBankAccountId = ba.id;
      }

      // Supplier Partner sale voucher only ever posts against the payable account
      // (Dr Bank/Cash = totalSalePrice, Cr Supplier Cash Payable = totalSalePrice).
      // Sales/COGS/Stock/Cost-Clearing accounts are NOT touched by this voucher —
      // COGS/profit/remaining-stock-value are derived from sp_stock_movements and
      // spSaleLines.finalUnitCostUsd instead (see totalFinalCost/grossProfit below).
      const payableAcct = await getSpAccount(companyId, "sp_payable");

      if (!payableAcct) {
        return res.status(400).json({ message: "SP accounts not configured. Run Setup first." });
      }

      const result = await db.transaction(async (tx) => {
        let totalSalePrice = 0;
        let totalBaseCost = 0;
        let totalFinalCost = 0;
        const postedLines: SpSalePostedLine[] = [];

        for (const sl of saleLines) {
          const qtySold = parseNum(sl.qtySold);
          const salePrice = parseNum(sl.salePricePerUnit);
          if (qtySold <= 0) continue;

          const articleCode = sl.articleCode ? String(sl.articleCode).trim() : null;
          let stockItemId = sl.stockItemId ? parseInt(sl.stockItemId) : null;

          if (!articleCode && !stockItemId) throw new Error("Each sale line needs articleCode or stockItemId");

          // ── Alias resolution: articleCode → stockItemId ───────────────────
          if (!stockItemId && articleCode) {
            const aliasRows = await tx
              .select()
              .from(stockItemCodeAliases)
              .where(
                and(eq(stockItemCodeAliases.companyId, companyId), eq(stockItemCodeAliases.aliasCode, articleCode))
              );
            if (aliasRows.length > 0) stockItemId = aliasRows[0].stockItemId;
          }

          // ── FIFO lot selection (server-side) ──────────────────────────────
          let lotsQuery: unknown;
          if (stockItemId) {
            lotsQuery = await tx.execute(
              sql`SELECT * FROM sp_stock_movements
                  WHERE company_id = ${companyId} AND stock_item_id = ${stockItemId} AND qty_remaining > 0
                  ORDER BY created_at ASC, id ASC FOR UPDATE`
            );
          } else {
            lotsQuery = await tx.execute(
              sql`SELECT * FROM sp_stock_movements
                  WHERE company_id = ${companyId} AND article_code = ${articleCode} AND qty_remaining > 0
                  ORDER BY created_at ASC, id ASC FOR UPDATE`
            );
          }

          const lots = resultRows<SpSaleLotRow>(lotsQuery);
          const totalAvail = lots.reduce((s: number, l) => s + parseNum(l.qty_remaining), 0);
          if (qtySold > totalAvail + 0.0001) {
            throw new Error(
              `Insufficient stock for ${articleCode || `item #${stockItemId}`}: available ${totalAvail.toFixed(4)}, requested ${qtySold}`
            );
          }

          let qtyLeft = qtySold;
          for (const lot of lots) {
            if (qtyLeft <= 0.0001) break;
            const qtyFromLot = Math.min(qtyLeft, parseNum(lot.qty_remaining));
            qtyLeft -= qtyFromLot;
            const baseUC = parseNum(lot.base_unit_cost_usd);
            const landedUC = parseNum(lot.landed_unit_cost_usd);
            const finalUC = parseNum(lot.final_unit_cost_usd);
            const saleTotal = qtyFromLot * salePrice;
            const baseTotal = qtyFromLot * baseUC;
            const finalTotal = qtyFromLot * finalUC;

            totalSalePrice += saleTotal;
            totalBaseCost += baseTotal;
            totalFinalCost += finalTotal;

            await tx.execute(
              sql`UPDATE sp_stock_movements SET qty_remaining = ${String(parseNum(lot.qty_remaining) - qtyFromLot)} WHERE id = ${lot.id}`
            );

            await adjustSpInventoryAtomic(tx, {
              companyId,
              locationId: lot.location_id,
              stockItemId: lot.stock_item_id,
              deltaQty: -qtyFromLot,
              context: `SP sale ${articleCode || `item #${stockItemId}`} from lot #${lot.id}`,
              sourceVoucherType: "SP_SALE",
            });

            postedLines.push({
              movementId: lot.id,
              articleCode: lot.article_code,
              description: lot.description || null,
              stockItemId: lot.stock_item_id || null,
              qtySold: qtyFromLot,
              salePricePerUnit: salePrice,
              baseUnitCostUsd: baseUC,
              landedUnitCostUsd: landedUC,
              finalUnitCostUsd: finalUC,
              saleTotal,
              baseTotal,
              finalTotal,
            });
          }
        }

        if (postedLines.length === 0) throw new Error("No valid sale lines");

        const grossProfit = totalSalePrice - totalFinalCost;

        const [sale] = await tx
          .insert(spSales)
          .values({
            companyId,
            saleDate,
            customerName,
            totalSalePriceUsd: String(totalSalePrice),
            totalBaseCostUsd: String(totalBaseCost),
            totalFinalCostUsd: String(totalFinalCost),
            grossProfitUsd: String(grossProfit),
            status: "posted",
            notes: notes || null,
          })
          .returning();

        const voucherNum = `SP-SALE-${sale.id}-${Date.now()}`;
        const [voucher] = await tx
          .insert(vouchers)
          .values({
            companyId,
            voucherType: "Journal",
            voucherNumber: voucherNum,
            voucherDate: saleDate,
            description: `Sale — ${customerName}`,
            totalAmount: String(totalSalePrice),
            currency: SP_RELEASE_CURRENCY,
            exchangeRate: SP_RELEASE_EXCHANGE_RATE,
            sourceModule: "SP",
          })
          .returning();

        // A settlement account is mandatory (validated above) so the voucher
        // always has exactly this Dr entry balancing the Cr Supplier Cash
        // Payable entry below — either a bank account or a Cash-type ledger
        // account, same choice normal ERP POS offers.
        await tx.insert(voucherEntries).values({
          voucherId: voucher.id,
          bankAccountId: settlementBankAccountId,
          ledgerAccountId: settlementLedgerAccountId,
          debitAmount: String(totalSalePrice),
          creditAmount: "0",
          narration: `Sale receipts — ${customerName}`,
        });

        // Supplier Partner sale voucher posts ONLY the customer cash collected —
        // it must never look like Bank+COGS (e.g. 1700 for a 1000 sale/700 cost).
        // Supplier Cash Payable = full selling price collected from the customer;
        // COGS/profit/stock value are derived separately from sp_stock_movements
        // and spSaleLines.finalUnitCostUsd (see totalFinalCost/grossProfit above),
        // never posted as extra Dr/Cr lines on this voucher.
        await tx.insert(voucherEntries).values({
          voucherId: voucher.id,
          ledgerAccountId: payableAcct.id,
          debitAmount: "0",
          creditAmount: String(totalSalePrice),
          narration: `Supplier Cash Payable — ${customerName}`,
        });

        await tx.insert(spSaleLines).values(
          postedLines.map((pl) => ({
            saleId: sale.id,
            companyId,
            movementId: pl.movementId,
            articleCode: pl.articleCode,
            description: pl.description || null,
            stockItemId: pl.stockItemId || null,
            qtySold: String(pl.qtySold),
            salePricePerUnit: String(pl.salePricePerUnit),
            baseUnitCostUsd: String(pl.baseUnitCostUsd),
            landedUnitCostUsd: String(pl.landedUnitCostUsd),
            finalUnitCostUsd: String(pl.finalUnitCostUsd),
          }))
        );

        await tx.update(spSales).set({ voucherId: voucher.id }).where(eq(spSales.id, sale.id));
        return { ...sale, voucherId: voucher.id, lines: postedLines };
      });

      res.json(result);
    } catch (error: unknown) {
      if (respondToSpInventoryIntegrityError(res, error)) return;
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── Stock Movements ───────────────────────────────────────────────────────

  app.get("/api/sp/stock", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;

      const movements = await db
        .select()
        .from(spStockMovements)
        .where(and(eq(spStockMovements.companyId, companyId), gt(spStockMovements.qtyRemaining, "0")))
        .orderBy(asc(spStockMovements.createdAt));

      res.json(movements);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/sp/stock/all", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;

      const movements = await db
        .select()
        .from(spStockMovements)
        .where(eq(spStockMovements.companyId, companyId))
        .orderBy(asc(spStockMovements.createdAt));

      res.json(movements);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
