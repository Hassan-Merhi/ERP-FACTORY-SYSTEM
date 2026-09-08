import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { buildLegacyValidSourceIds, isRowIntegrityValid } from "../../services/factory/daybookSourceIntegrity";
import { requireAuth } from "../../auth";

import {
  factoryBaleProducts,
  factoryBales,
  customerOrders,
  factoryDaybookEntries,
  factoryUserProfiles,
  vouchers,
} from "@shared/schema";
import { eq, and, or, desc, sql, inArray, isNull } from "drizzle-orm";

export function registerFactoryDaybookRoutes(app: Express) {
  app.get(
    "/api/factory/daybook",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const currentUserId = req.session.userId != null ? String(req.session.userId) : undefined;
        // startDate/endDate are reassigned by the unbounded-range guard below;
        // the other two are read as sent.
        let { startDate, endDate } = req.query;
        // Query values arrive as string | string[] | ParsedQs; every use below wants
        // a plain string, so normalise once instead of casting at each use.
        const txType = req.query.txType ? String(req.query.txType) : undefined;
        const currencyCode = req.query.currencyCode ? String(req.query.currencyCode) : undefined;

        // Guard against unbounded "return everything ever" queries: only apply when
        // the caller omits the params entirely (e.g. a raw/older API call) — not when
        // the client explicitly sent empty strings for its "All Time" preset. The
        // client always sends startDate/endDate now (even as "" for All Time), so an
        // actual `undefined` here means the params were never sent at all.
        if (startDate === undefined && endDate === undefined) {
          const todayStr = new Date().toISOString().slice(0, 10);
          startDate = todayStr;
          endDate = todayStr;
        }

        // ── Check if this user has "daybook_own_only" restriction ─────────────
        let ownOnly = false;
        if (currentUserId) {
          const [profile] = await db
            .select({ hiddenCostFields: factoryUserProfiles.hiddenCostFields })
            .from(factoryUserProfiles)
            .where(and(eq(factoryUserProfiles.companyId, companyId), eq(factoryUserProfiles.userId, currentUserId)));
          if (profile?.hiddenCostFields?.includes("daybook_own_only")) ownOnly = true;
        }

        // ── 1. Query existing factory_daybook_entries ──────────────────────────
        const conditions = [
          eq(factoryDaybookEntries.companyId, companyId),
          // Exclude void/delete audit entries — they are internal records, not daybook events
          sql`${factoryDaybookEntries.txType} NOT LIKE '%_VOIDED'`,
          sql`${factoryDaybookEntries.txType} NOT LIKE '%_DELETED'`,
          // Exclude order-status-change events — operational/workflow events, not financial
          sql`${factoryDaybookEntries.txType} NOT IN (
          'LOADING_SUBMITTED',
          'ORDER_VERIFIED',
          'INVOICE_REVERTED',
          'SUPPLIER_FX_TRANSFER_DELETE',
          'WORKER_CREATED',
          'ORDER_CANCELLED',
          'CONTRACT_SETTLED',
          'CONTRACT_REACTIVATED',
          'CONTRACT_ENDED'
        )`,
          // Hide zero-amount payroll payment entries — no money moved, nothing to show
          sql`NOT (
          ${factoryDaybookEntries.txType} = 'PAYROLL_PAYMENT'
          AND (${factoryDaybookEntries.amountCurrency} IS NULL OR ${factoryDaybookEntries.amountCurrency}::numeric = 0)
        )`,
        ];
        // If user is restricted to own entries only, show their entries + unattributed ones (NULL createdBy)
        if (ownOnly && currentUserId) {
          conditions.push(
            or(eq(factoryDaybookEntries.createdBy, currentUserId), isNull(factoryDaybookEntries.createdBy))!
          );
        }
        if (startDate) conditions.push(sql`${factoryDaybookEntries.txDate} >= ${startDate}`);
        if (endDate) conditions.push(sql`${factoryDaybookEntries.txDate} <= ${endDate}`);
        if (txType) conditions.push(eq(factoryDaybookEntries.txType, txType));
        if (currencyCode) conditions.push(eq(factoryDaybookEntries.currencyCode, currencyCode));
        const daybookRows = await db
          .select()
          .from(factoryDaybookEntries)
          .where(and(...conditions))
          .orderBy(desc(factoryDaybookEntries.txDate), desc(factoryDaybookEntries.id));

        // ── 1b. Safety-net: drop real daybook entries whose source voucher was deleted ─
        // Also fetch `optional` flag for voucher-backed rows
        const voucherRefIds = daybookRows
          .filter((r) => r.referenceTable === "vouchers" && r.referenceId != null)
          .map((r) => r.referenceId as number);

        const validVoucherIds = new Set<number>();
        const voucherOptionalMap = new Map<number, boolean>();
        // Also store live description/amount so stale daybook entries always show
        // current voucher data after an edit.
        const voucherLiveDataMap = new Map<
          number,
          {
            description: string;
            amountCurrency: string;
            amountUsd: string;
            fxRateToUsd: string;
            voucherNumber: string;
            effectiveDate: string | null;
          }
        >();
        if (voucherRefIds.length > 0) {
          const liveVouchers = await db
            .select({
              id: vouchers.id,
              optional: vouchers.optional,
              description: vouchers.description,
              totalAmount: vouchers.totalAmount,
              currency: vouchers.currency,
              exchangeRate: vouchers.exchangeRate,
              voucherType: vouchers.voucherType,
              voucherNumber: vouchers.voucherNumber,
              effectiveDate: vouchers.effectiveDate,
            })
            .from(vouchers)
            .where(and(inArray(vouchers.id, voucherRefIds), sql`${vouchers.deletedAt} IS NULL`));
          liveVouchers.forEach((v) => {
            validVoucherIds.add(v.id);
            voucherOptionalMap.set(v.id, !!v.optional);
            const currency = v.currency || "USD";
            const fxRate = parseFloat(v.exchangeRate || "1") || 1;
            const amtCurrency = parseFloat(v.totalAmount || "0");
            const amtUsd = currency === "USD" ? amtCurrency : amtCurrency * fxRate;
            voucherLiveDataMap.set(v.id, {
              description: v.description || `${v.voucherType} voucher #${v.voucherNumber}`,
              amountCurrency: String(amtCurrency),
              amountUsd: String(amtUsd),
              fxRateToUsd: String(fxRate),
              voucherNumber: v.voucherNumber || "",
              effectiveDate: v.effectiveDate || null,
            });
          });
        }

        // ── 1c. Shared source-integrity check for all registered source-backed types ────────
        // Batch-fetches valid source IDs via the central daybookSourceIntegrity registry.
        // Replaces the former per-type ad-hoc blocks (payrolls, advances, repayments,
        // containers) with a single parallel fetch covering all 12 source groups.
        const validSourceIds = await buildLegacyValidSourceIds(daybookRows, companyId);

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
            return { ...r, optional: false };
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

        let syntheticRows: any[] = [];
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
            sql`${vouchers.deletedAt} IS NULL`,
            inArray(vouchers.voucherType, ["Payment", "Receipt", "Journal"]),
          ];
          if (startDate)
            voucherConds.push(sql`COALESCE(${vouchers.effectiveDate}, ${vouchers.voucherDate}) >= ${startDate}`);
          if (endDate)
            voucherConds.push(sql`COALESCE(${vouchers.effectiveDate}, ${vouchers.voucherDate}) <= ${endDate}`);
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
              const currency = v.currency || "USD";
              const fxRate = parseFloat(v.exchangeRate || "1") || 1;
              const amtCurrency = parseFloat(v.totalAmount || "0");
              const amtUsd = currency === "USD" ? amtCurrency : amtCurrency * fxRate;
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
        // and zero-amount LOADING_SUBMITTED / ORDER_VERIFIED entries.
        // BALE_STOCK_ENTRY is always re-derived so old entries stored as selling price
        // are corrected to production price on the fly without a DB migration.
        const baleStockAndZeroRows = filteredDaybookRows.filter(
          (r) =>
            r.txType === "BALE_STOCK_ENTRY" ||
            (parseFloat(r.amountCurrency || "0") === 0 && ["LOADING_SUBMITTED", "ORDER_VERIFIED"].includes(r.txType))
        );
        // Alias kept so the rest of the block compiles unchanged
        const zeroRows = baleStockAndZeroRows;

        if (zeroRows.length > 0) {
          // BALE_STOCK_ENTRY: derive from bale IDs stored in metaJson
          const baleStockRows = zeroRows.filter((r) => r.txType === "BALE_STOCK_ENTRY");
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
                  baleIdToEntry.get(numId)!.push({ row, weightKg: parseFloat(b.weightKg || "0") });
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
              const productProductionPriceById = new Map<number, number>();
              const productProductionPriceByArticleCode = new Map<string, number>();
              const allProducts = await db
                .select({
                  id: factoryBaleProducts.id,
                  articleCode: factoryBaleProducts.articleCode,
                  productionPrice: factoryBaleProducts.productionPrice,
                })
                .from(factoryBaleProducts)
                .where(eq(factoryBaleProducts.companyId, companyId));
              allProducts.forEach((p) => {
                productProductionPriceById.set(p.id, parseFloat(p.productionPrice || "0"));
                if (p.articleCode)
                  productProductionPriceByArticleCode.set(p.articleCode, parseFloat(p.productionPrice || "0"));
              });

              // Accumulate value per daybook row id using productionPrice (per bale)
              const rowValueMap = new Map<number, number>();
              for (const baleRec of baleRecords) {
                const entries = baleIdToEntry.get(baleRec.id) || [];
                let val = 0;
                // primary: productId → productionPrice
                if (baleRec.productId) val = productProductionPriceById.get(baleRec.productId) || 0;
                // fallback: articleCode → productionPrice
                if (val === 0 && baleRec.articleCode)
                  val = productProductionPriceByArticleCode.get(baleRec.articleCode) || 0;
                for (const { row } of entries) {
                  rowValueMap.set(row.id, (rowValueMap.get(row.id) || 0) + val);
                }
              }

              // Patch the filteredDaybookRows in-place.
              // BALE_STOCK_ENTRY is always overwritten so old rows stored with
              // selling price are corrected to production price on the fly.
              for (const row of filteredDaybookRows) {
                if (row.txType === "BALE_STOCK_ENTRY") {
                  const derived = rowValueMap.get(row.id);
                  if (derived && derived > 0) {
                    row.amountCurrency = String(derived.toFixed(2));
                    row.amountUsd = String(derived.toFixed(2));
                  }
                }
              }
            }
          }

          // LOADING_SUBMITTED / ORDER_VERIFIED: derive from customerOrders.grandTotal
          // (grandTotal includes bales + all charges/surcharges, not just bale prices)
          const loadingRows = zeroRows.filter(
            (r) => ["LOADING_SUBMITTED", "ORDER_VERIFIED"].includes(r.txType) && r.referenceId
          );
          if (loadingRows.length > 0) {
            const orderIds = [...new Set(loadingRows.map((r) => r.referenceId as number))];
            const orderGrandTotals = await db
              .select({
                id: customerOrders.id,
                grandTotal: customerOrders.grandTotal,
              })
              .from(customerOrders)
              .where(inArray(customerOrders.id, orderIds));

            const orderTotals = new Map<number, number>();
            for (const o of orderGrandTotals) {
              orderTotals.set(o.id, parseFloat(o.grandTotal || "0"));
            }

            for (const row of filteredDaybookRows as any[]) {
              if (
                ["LOADING_SUBMITTED", "ORDER_VERIFIED"].includes(row.txType) &&
                parseFloat(row.amountCurrency || "0") === 0
              ) {
                const total = orderTotals.get(row.referenceId);
                if (total && total > 0) {
                  row.amountCurrency = String(total.toFixed(2));
                  row.amountUsd = String(total.toFixed(2));
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
    }
  );

  // ───────────────────────────────────────────────
  // FACTORY CUSTOMERS CRUD
  // ───────────────────────────────────────────────
}
