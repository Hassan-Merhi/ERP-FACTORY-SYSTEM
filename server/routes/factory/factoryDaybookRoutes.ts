import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { isRowIntegrityValid } from "../../services/factory/daybookSourceIntegrity";
import { requireAuth } from "../../auth";

import { factoryBaleProducts, factoryBales, customerOrders, factoryDaybookEntries, vouchers } from "@shared/schema";
import { eq, and, sql, inArray } from "drizzle-orm";
import { sumMoney, toMoney } from "../../lib/money";
import { operationalHistoricalSupplierExclusionSql } from "../../services/accounting/internalHistoricalSupplierRoutineVisibility";
import { liveVoucherAmounts } from "./factoryDaybookRoutesHelpers";
import { factoryDaybookRoutesStep } from "./factoryDaybookRoutesStep";

export function registerFactoryDaybookRoutes(app: Express) {
  // Live totals for visible Loading Started rows. Small, company-scoped response
  // so the daybook can update dollar amounts without reloading its full history.
  app.get("/api/factory/daybook/loading-amounts", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const rawOrderIds = req.query.orderIds;
      if (typeof rawOrderIds !== "string" || !/^\d+(,\d+)*$/.test(rawOrderIds)) {
        return res.status(400).json({ message: "Provide comma-separated order IDs" });
      }
      const orderIds = [...new Set(rawOrderIds.split(",").map(Number))];
      if (orderIds.length > 150 || orderIds.some((id) => !Number.isSafeInteger(id) || id < 1)) {
        return res.status(400).json({ message: "Up to 150 valid order IDs are allowed" });
      }

      const orders = await db
        .select({ id: customerOrders.id, grandTotal: customerOrders.grandTotal })
        .from(customerOrders)
        .where(
          and(
            eq(customerOrders.companyId, companyId),
            inArray(customerOrders.id, orderIds),
            sql`EXISTS (
              SELECT 1 FROM factory_daybook_entries fde
              WHERE fde.company_id = ${companyId}
                AND fde.reference_table = 'customer_orders'
                AND fde.reference_id = ${customerOrders.id}
                AND fde.tx_type = 'LOADING_CREATED'
            )`
          )
        );
      res.json({
        amounts: Object.fromEntries(orders.map((order) => [order.id, toMoney(order.grandTotal).toFixed(2)])),
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/factory/daybook", requireAuth, async (req: Request, res: Response) => {
    try {
      const fdr1 = await factoryDaybookRoutesStep({ req, res });
      if (fdr1.done) return fdr1.value;
      const {
        daybookRows,
        validVoucherIds,
        validSourceIds,
        voucherLiveDataMap,
        voucherOptionalMap,
        enrichOffloadNarration,
        txType,
        companyId,
        startDate,
        endDate,
        currencyCode,
        ownOnly,
      } = fdr1;

      const filteredDaybookRows = daybookRows
        .filter((r) => {
          // Voucher check uses live-data maps from block 1b (supports description/amount refresh).
          if (r.referenceTable === "vouchers" && r.referenceId != null) {
            return validVoucherIds.has(r.referenceId);
          }
          // All other source-backed types: registry-driven validity check.
          return isRowIntegrityValid(r, validSourceIds);
        })
        .map((r) => {
          if (r.referenceTable === "vouchers" && r.referenceId != null) {
            const live = voucherLiveDataMap.get(r.referenceId);
            return {
              ...r,
              optional: voucherOptionalMap.get(r.referenceId) ?? false,
              // Always use live voucher description and amount so edits reflect immediately
              ...(live
                ? {
                    description: live.description,
                    amountCurrency: live.amountCurrency,
                    amountUsd: live.amountUsd,
                    fxRateToUsd: live.fxRateToUsd,
                    voucherNumber: live.voucherNumber,
                    effectiveDate: live.effectiveDate ?? r.effectiveDate ?? null,
                  }
                : {}),
            };
          }
          return {
            ...r,
            optional: false,
            description:
              r.txType === "OFFLOAD_RAW_STOCK" ? enrichOffloadNarration(r.description, r.referenceId) : r.description,
          };
        });

      // ── 2. Query vouchers directly (to catch pre-fix historical entries) ───
      // Only include Payment / Receipt / Journal vouchers in the daybook view
      const voucherTxTypeMap: Record<string, string> = {
        Payment: "PAYMENT",
        Receipt: "RECEIPT",
        Journal: "JOURNAL",
      };
      // If a txType filter is applied, skip voucher pull for non-voucher types
      const voucherTypesReversed: Record<string, string> = {
        PAYMENT: "Payment",
        RECEIPT: "Receipt",
        JOURNAL: "Journal",
      };
      const shouldFetchVouchers = !txType || txType in voucherTypesReversed;

      type SyntheticDaybookRow = {
        id: number;
        companyId: number;
        txDate: string;
        txType: string;
        referenceId: number;
        referenceTable: string;
        description: string;
        currencyCode: string;
        amountCurrency: string;
        fxRateToUsd: string;
        amountUsd: string;
        optional: boolean;
        createdAt: Date;
        createdBy: null;
        voucherNumber: string;
        effectiveDate: string | null;
      };
      let syntheticRows: SyntheticDaybookRow[] = [];
      if (shouldFetchVouchers) {
        // Build the set of voucher IDs already captured in factory_daybook_entries.
        // IMPORTANT: query ALL entries for the company (no date filter) so that when a
        // voucher's date is changed, the real daybook entry (which keeps its original
        // txDate) still suppresses the synthetic row — preventing duplicates when the
        // real entry's txDate and the voucher's voucherDate are in different date windows.
        const allCapturedRows = await db
          .select({ referenceId: factoryDaybookEntries.referenceId })
          .from(factoryDaybookEntries)
          .where(
            and(
              eq(factoryDaybookEntries.companyId, companyId),
              eq(factoryDaybookEntries.referenceTable, "vouchers"),
              sql`${factoryDaybookEntries.referenceId} IS NOT NULL`
            )
          );
        const capturedVoucherIds = new Set<number>(allCapturedRows.map((r) => r.referenceId as number));

        const voucherConds = [
          eq(vouchers.companyId, companyId),
          // Bonus claims have dedicated source-backed Daybook entries.
          // Suppress synthetic Payment/Receipt duplicates for both posted and reversed claims.
          sql`NOT EXISTS (
            SELECT 1 FROM factory_target_bonus_payments p WHERE p.company_id = ${companyId}
              AND (p.payment_voucher_id = ${vouchers.id} OR p.reversal_voucher_id = ${vouchers.id})
          )`,
          sql`NOT EXISTS (
            SELECT 1 FROM factory_target_bonus_weekly_payments p WHERE p.company_id = ${companyId}
              AND (p.payment_voucher_id = ${vouchers.id} OR p.reversal_voucher_id = ${vouchers.id})
          )`,
          sql`${vouchers.deletedAt} IS NULL`,
          inArray(vouchers.voucherType, ["Payment", "Receipt", "Journal"]),
          // Routine synthetic voucher view only; retain actual factory daybook
          // source transactions and all official financial journals.
          sql.raw(operationalHistoricalSupplierExclusionSql(companyId, "vouchers")),
        ];
        if (startDate)
          voucherConds.push(sql`COALESCE(${vouchers.effectiveDate}, ${vouchers.voucherDate}) >= ${startDate}`);
        if (endDate) voucherConds.push(sql`COALESCE(${vouchers.effectiveDate}, ${vouchers.voucherDate}) <= ${endDate}`);
        if (txType && txType in voucherTypesReversed) {
          voucherConds.push(eq(vouchers.voucherType, voucherTypesReversed[txType]));
        }
        if (currencyCode && currencyCode !== "ALL") {
          voucherConds.push(eq(vouchers.currency, currencyCode));
        }

        const rawVouchers = await db
          .select()
          .from(vouchers)
          .where(and(...voucherConds));

        syntheticRows = rawVouchers
          .filter((v) => !capturedVoucherIds.has(v.id))
          .map((v) => {
            const txTypeVal = voucherTxTypeMap[v.voucherType] || "JOURNAL";
            const { currency, fxRate, amtCurrency, amtUsd } = liveVoucherAmounts(v);
            return {
              id: -v.id, // negative id so FE can distinguish; won't clash with real ids
              companyId: v.companyId,
              txDate: v.effectiveDate || v.voucherDate,
              txType: txTypeVal,
              referenceId: v.id,
              referenceTable: "vouchers",
              description: v.description || `${v.voucherType} voucher #${v.voucherNumber}`,
              currencyCode: currency,
              amountCurrency: String(amtCurrency),
              fxRateToUsd: String(fxRate),
              amountUsd: String(amtUsd),
              optional: !!v.optional,
              createdAt: v.createdAt,
              createdBy: null,
              voucherNumber: v.voucherNumber || "",
              effectiveDate: v.effectiveDate || null,
            };
          });
      }

      // ── 2b. Enrich BALE_STOCK_ENTRY (always re-derive from productionPrice) ──
      // BALE_STOCK_ENTRY is always re-derived so old entries stored as selling price
      // are corrected to production price on the fly without a DB migration.
      // (LOADING_SUBMITTED / ORDER_VERIFIED never reach here: the step query
      // excludes them as workflow events, so they need no amount enrichment.)
      const baleStockRows = filteredDaybookRows.filter((r) => r.txType === "BALE_STOCK_ENTRY");
      // Derive from bale IDs stored in metaJson
      if (baleStockRows.length > 0) {
        // Collect all bale IDs across all zero bale stock entries
        // Only integer IDs are valid — old entries may have stored UUIDs which Postgres rejects
        const baleIdToEntry = new Map();
        for (const row of baleStockRows) {
          try {
            const meta = JSON.parse(row.metaJson || "{}");
            const bales = Array.isArray(meta.bales) ? meta.bales : [];
            for (const b of bales) {
              const numId = parseInt(b.id, 10);
              if (!b.id || isNaN(numId) || String(numId) !== String(b.id)) continue; // skip UUIDs / non-integers
              if (!baleIdToEntry.has(numId)) baleIdToEntry.set(numId, []);
              baleIdToEntry.get(numId)!.push({ row, weightKg: toMoney(b.weightKg).toNumber() });
            }
          } catch {
            // Failure here is non-fatal and the surrounding flow continues deliberately.
          }
        }
        if (baleIdToEntry.size > 0) {
          const allBaleIds = Array.from(baleIdToEntry.keys());
          // Fetch costPerKg, productId, and articleCode for multi-level fallback
          const baleRecords = await db
            .select({
              id: factoryBales.id,
              costPerKg: factoryBales.costPerKg,
              productId: factoryBales.productId,
              articleCode: factoryBales.articleCode,
            })
            .from(factoryBales)
            .where(inArray(factoryBales.id, allBaleIds));

          // Build product production price map: by id (primary) and by articleCode (fallback)
          // Production price is what was spent to produce the bale — used for cost-side daybook entries.
          const productProductionPriceById = new Map<number, string>();
          const productProductionPriceByArticleCode = new Map<string, string>();
          const allProducts = await db
            .select({
              id: factoryBaleProducts.id,
              articleCode: factoryBaleProducts.articleCode,
              productionPrice: factoryBaleProducts.productionPrice,
            })
            .from(factoryBaleProducts)
            .where(eq(factoryBaleProducts.companyId, companyId));
          allProducts.forEach((p) => {
            productProductionPriceById.set(p.id, p.productionPrice || "0");
            if (p.articleCode) productProductionPriceByArticleCode.set(p.articleCode, p.productionPrice || "0");
          });

          // Accumulate value per daybook row id using productionPrice (per bale)
          const rowValues = new Map<number, string[]>();
          for (const baleRec of baleRecords) {
            const entries = baleIdToEntry.get(baleRec.id) || [];
            let val = toMoney(0);
            // primary: productId → productionPrice
            if (baleRec.productId) val = toMoney(productProductionPriceById.get(baleRec.productId));
            // fallback: articleCode → productionPrice
            if (val.isZero() && baleRec.articleCode)
              val = toMoney(productProductionPriceByArticleCode.get(baleRec.articleCode));
            for (const { row } of entries) {
              rowValues.set(row.id, [...(rowValues.get(row.id) || []), val.toString()]);
            }
          }

          // Patch the filteredDaybookRows in-place.
          // BALE_STOCK_ENTRY is always overwritten so old rows stored with
          // selling price are corrected to production price on the fly.
          for (const row of filteredDaybookRows) {
            if (row.txType === "BALE_STOCK_ENTRY") {
              const values = rowValues.get(row.id);
              const derived = values ? sumMoney(values) : null;
              if (derived && derived.gt(0)) {
                row.amountCurrency = String(derived.toFixed(2));
                row.amountUsd = String(derived.toFixed(2));
              }
            }
          }
        }
      }

      // ── 2c. Deduplicate singleton event types ────────────────────────────────
      // State-change events (INVOICE, INVOICE_REVERTED, ORDER_VERIFIED, ORDER_CANCELLED)
      // can be written multiple times for the same referenceId when an order is
      // approved → reverted → re-approved repeatedly. Keep only the latest entry
      // (highest id) per (txType, referenceId). The array is already sorted
      // desc by id so the first occurrence of each key is the most recent.
      const SINGLETON_TX_TYPES = new Set(["INVOICE", "INVOICE_REVERTED", "ORDER_VERIFIED", "ORDER_CANCELLED"]);
      const _seenSingletonKeys = new Set<string>();
      const deduplicatedRows = filteredDaybookRows.filter((r) => {
        if (!SINGLETON_TX_TYPES.has(r.txType) || r.referenceId == null) return true;
        const key = `${r.txType}:${r.referenceId}`;
        if (_seenSingletonKeys.has(key)) return false;
        _seenSingletonKeys.add(key);
        return true;
      });

      // ── 3. Merge + sort ────────────────────────────────────────────────────
      // If ownOnly, exclude synthetic rows (voucher-derived rows with no createdBy)
      const effectiveSyntheticRows = ownOnly ? [] : syntheticRows;
      const merged = [...deduplicatedRows, ...effectiveSyntheticRows].sort((a, b) => {
        if (b.txDate > a.txDate) return 1;
        if (b.txDate < a.txDate) return -1;
        return Math.abs(b.id) - Math.abs(a.id);
      });

      res.json(merged);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ───────────────────────────────────────────────
  // FACTORY CUSTOMERS CRUD
  // ───────────────────────────────────────────────
}
