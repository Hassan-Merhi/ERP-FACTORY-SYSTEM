/**
 * supplierBalanceRoutes: SupplierWithBalances endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { logger } from "../../../../lib/logger";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import { sqlArray } from "../../../../lib/sqlArray";
import { resolveStoredFxRate } from "../../../../services/factory/currencyConversion";
import { toMoney, sumMoney, MoneyDecimal } from "../../../../lib/money";
import type Decimal from "decimal.js";
import {
  factorySuppliers,
  factoryContainers,
  voucherEntries,
  factoryOffloadAdditionalCharges,
  vouchers,
  factorySupplierPayments,
  factorySupplierFxTransfers,
} from "@shared/schema";
import { eq, and, sql, inArray, isNull } from "drizzle-orm";
import { buildBrokerStatement, isPayableContainer, isSupplierPaidFreight, resolveDisplayFx } from "./_helpers";
import {
  emptyFactorySupplierLedgerView,
  FACTORY_SUPPLIER_OPERATIONAL_MEMO_LABEL,
  loadFactorySupplierLedgerViews,
} from "./factorySupplierLedger";
import {
  entryNativeAmounts,
  entryStoredUsdAmounts,
  voucherEntryCurrencyColumns,
} from "../../../../services/factory/voucherEntryCurrency";

// Balances are summed as exact decimals (server/lib/money.ts) and only turned
// into numbers or fixed-point strings when the response is built.
type MoneyBucket = Record<string, Decimal>;
const ZERO = new MoneyDecimal(0);
const addTo = (bucket: MoneyBucket, key: string, amount: Decimal) => {
  bucket[key] = (bucket[key] ?? ZERO).plus(amount);
};
type ContainerAmounts = {
  actualReceivedKg: string | null;
  totalKg: string | null;
  ratePerKg: string | null;
  freight: string | null;
};
/** Received (else declared) kg × rate, plus freight when the supplier pays it. */
const receivedValue = (c: ContainerAmounts & Record<string, unknown>) =>
  toMoney(c.actualReceivedKg || c.totalKg)
    .times(toMoney(c.ratePerKg))
    .plus(isSupplierPaidFreight(c) ? toMoney(c.freight) : ZERO);

export function registerSupplierWithBalancesRoutes(app: Express) {
  app.get("/api/factory/suppliers/with-balances", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const includeOtw = req.query.includeOtw === "true";

      const suppliersList = await db
        .select()
        .from(factorySuppliers)
        .where(eq(factorySuppliers.companyId, companyId))
        .orderBy(factorySuppliers.name);

      const containers = await db
        .select()
        .from(factoryContainers)
        .where(and(eq(factoryContainers.companyId, companyId), isNull(factoryContainers.deletedAt)));

      const allPayments = await db
        .select()
        .from(factorySupplierPayments)
        .where(eq(factorySupplierPayments.companyId, companyId));

      const allFxTransfers = await db
        .select()
        .from(factorySupplierFxTransfers)
        .where(eq(factorySupplierFxTransfers.companyId, companyId));

      // Voucher-based payments: debit entries on voucherEntries where factorySupplierId is set.
      // Exclude FACTORY-PAY-* vouchers — those are auto-generated from factorySupplierPayments
      // and are already counted in allPayments (would double-count otherwise).
      const allSupplierIds = suppliersList.map((s) => s.id);
      const voucherFxUnresolvedSuppliers = new Set<number>();
      const voucherPaidBySupplierCurrency: Record<number, MoneyBucket> = {};
      const voucherPaidBySupplierCurrencyUsd: Record<number, MoneyBucket> = {};
      if (allSupplierIds.length > 0) {
        const voucherPaymentRows = await db
          .select({
            factorySupplierId: voucherEntries.factorySupplierId,
            ...voucherEntryCurrencyColumns,
            exchangeRate: vouchers.exchangeRate,
            optional: vouchers.optional,
          })
          .from(voucherEntries)
          .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
          .where(
            and(
              inArray(voucherEntries.factorySupplierId, allSupplierIds),
              // A voucher line belongs to its voucher's company; deleted and optional
              // vouchers never reach a balance (soft delete keeps the lines).
              eq(vouchers.companyId, companyId),
              eq(vouchers.optional, false),
              isNull(vouchers.deletedAt),
              sql`${voucherEntries.debitAmount}::numeric > 0`,
              sql`${vouchers.voucherNumber} NOT LIKE 'FACTORY-PAY-%'`
            )
          );
        for (const row of voucherPaymentRows) {
          const suppId = row.factorySupplierId;
          if (!suppId) continue;
          if (row.optional) continue; // optional vouchers don't affect the balance
          // Native amount in its own currency; a normalized entry also holds
          // its USD base, and only a legacy foreign-currency entry is
          // converted from the voucher's rate.
          const native = entryNativeAmounts(row);
          const amt = native.debit;
          const curr = native.currency;
          const stored = entryStoredUsdAmounts(row);
          let usdAmt: Decimal;
          if (stored) {
            usdAmt = stored.debit;
          } else {
            // vouchers.exchangeRate has no fxRateConfirmed column yet — legacy heuristic stopgap.
            const { fxRate: fx, looksSet } = resolveStoredFxRate(curr, row.exchangeRate);
            if (!looksSet) {
              voucherFxUnresolvedSuppliers.add(suppId);
              continue; // exclude from the total rather than guess at 1
            }
            usdAmt = amt.dividedBy(fx);
          }
          addTo((voucherPaidBySupplierCurrency[suppId] ??= {}), curr, amt);
          addTo((voucherPaidBySupplierCurrencyUsd[suppId] ??= {}), curr, usdAmt);
        }
      }

      // Load the user-configured display FX rates (e.g. EUR=1.18, AUD=0.75)
      // These are the same rates shown on the Net Position page.
      const fxRateRows = await db.execute<{ currency_code: string; rate_to_usd: string }>(sql`
        SELECT DISTINCT ON (currency_code) currency_code, rate_to_usd
        FROM factory_fx_rates
        WHERE company_id = ${companyId} AND source = 'manual'
        ORDER BY currency_code, effective_date DESC
      `);
      const configuredFxRates: Record<string, number> = {};
      for (const row of fxRateRows.rows) {
        configuredFxRates[row.currency_code] = Number(row.rate_to_usd);
      }

      // Pre-fetch post-offload charges explicitly assigned to a supplier (supplierId NOT NULL).
      // Charges posted to a ledger account have supplierId=null and must NOT appear on any supplier balance.
      const allOffloadAdditionalCharges =
        allSupplierIds.length > 0
          ? await db
              .select({
                supplierId: factoryOffloadAdditionalCharges.supplierId,
                amount: factoryOffloadAdditionalCharges.amount,
                currencyCode: factoryOffloadAdditionalCharges.currencyCode,
                fxRateToUsd: factoryOffloadAdditionalCharges.fxRateToUsd,
              })
              .from(factoryOffloadAdditionalCharges)
              .where(
                and(
                  eq(factoryOffloadAdditionalCharges.companyId, companyId),
                  sql`${factoryOffloadAdditionalCharges.supplierId} = ANY(${sqlArray(allSupplierIds)})`
                )
              )
          : [];

      // Primary balances (wave 13, owner decision 3): the ledger from the balance
      // engine, the native balance per currency of the same lines, and the
      // container amounts not yet in the ledger. The operational figures
      // computed below are returned only as a labelled memo.
      const ledgerViews = await loadFactorySupplierLedgerViews(db, companyId, { ids: allSupplierIds });
      const ledgerFields = (supplierId: number) => {
        const view = ledgerViews.get(supplierId) ?? emptyFactorySupplierLedgerView(supplierId);
        return {
          totalValue: view.ledgerBalanceUsd,
          balanceBasis: view.balanceBasis,
          ledgerBalance: view.ledgerBalanceUsd,
          ledgerBalanceSide: view.ledgerBalanceSide,
          currencyBalances: view.nativeBalances
            .filter((bucket) => toMoney(bucket.balance).abs().gt(0.001))
            .map((bucket) => ({
              currencyCode: bucket.currencyCode,
              balance: toMoney(bucket.balance).toNumber(),
              fxRateToUsd: toMoney(bucket.effectiveFxRateToUsd ?? 0).toNumber(),
            })),
          nativeBalances: view.nativeBalances,
          notInLedgerTotal: view.notInLedger.total,
          notInLedger: view.notInLedger,
          fxUnresolved: view.ledgerFxUnresolved,
        };
      };

      const ledgerExposure = (supplierIds: number[]) => {
        const native: MoneyBucket = {};
        const usd: MoneyBucket = {};
        for (const id of supplierIds) {
          for (const bucket of ledgerViews.get(id)?.nativeBalances ?? []) {
            if (!toMoney(bucket.balance).gt(0)) continue;
            addTo(native, bucket.currencyCode, toMoney(bucket.balance));
            addTo(usd, bucket.currencyCode, toMoney(bucket.usdBalance));
          }
        }
        return Object.entries(native)
          .filter(([, balance]) => balance.gt(0.001))
          .map(([currencyCode, balance]) => ({
            currencyCode,
            balance: balance.toNumber(),
            fxRateToUsd: currencyCode === "USD" ? 1 : (usd[currencyCode] ?? ZERO).dividedBy(balance).toNumber(),
          }))
          .sort((a, _b) => (a.currencyCode === "USD" ? 1 : -1));
      };

      // Helper to compute stats for a single supplier record
      const computeStats = (s: typeof factorySuppliers.$inferSelect, includeOtw: boolean = false) => {
        const supplierContainers = containers.filter((c) => c.supplierId === s.id);
        const payableContainers = supplierContainers.filter(
          (c) => isPayableContainer(c) || (includeOtw && (c.status === "PENDING" || c.status === "IN_TRANSIT"))
        );
        const totalContainers = supplierContainers.length;
        const totalKg = sumMoney(supplierContainers.map((c) => c.actualReceivedKg || c.totalKg));
        // Commission accumulates under the supplier, EXCEPT:
        // if this supplier is linked to a broker (has parentId), USD commission flows to the broker.
        const commissionValue = payableContainers.reduce((sum, c) => {
          const commAmt = toMoney(c.commissionAmount);
          if (commAmt.lte(0)) return sum;
          const commCurr = c.commissionCurrencyCode || c.currencyCode || "USD";
          // Linked supplier: USD commission is absorbed by the parent broker — skip here
          if (s.parentId && commCurr === "USD") return sum;
          const commFx = resolveDisplayFx(
            commCurr,
            configuredFxRates[commCurr],
            commCurr === (c.currencyCode || "USD") ? c.fxRateToUsd : undefined,
            commCurr === (c.currencyCode || "USD") ? c.fxRateConfirmed : undefined
          );
          return sum.plus(commCurr === "USD" ? commAmt : commAmt.times(commFx));
        }, ZERO);
        const pendingConts = supplierContainers.filter((c) => c.status === "PENDING" || c.status === "IN_TRANSIT");
        const pendingContainers = pendingConts.length;
        const otwByCurrency: Record<string, number> = {};
        for (const c of pendingConts) {
          const cc = (c.currencyCode || "USD").toUpperCase();
          otwByCurrency[cc] = (otwByCurrency[cc] || 0) + 1;
        }
        const receivedContainers = supplierContainers.filter(
          (c) => c.status === "RECEIVED" || c.status === "PARTIALLY_RECEIVED" || c.status === "OFFLOADED"
        ).length;
        const lastContainerDate =
          supplierContainers.length > 0
            ? supplierContainers.reduce((latest: string | null, c) => {
                const d = c.arrivalDate || c.createdAt.toISOString();
                if (!latest) return d;
                return new Date(d) > new Date(latest) ? d : latest;
              }, null)
            : null;
        const supplierPayments = allPayments.filter((p) => p.supplierId === s.id);
        const totalPaid = sumMoney(supplierPayments.map((p) => p.amountUsd));
        // Per-currency balances (original currency, not converted).
        // Track both native amount AND USD equivalent for every transaction so that
        // fxRateToUsd = usdSum / nativeSum — an effective rate that always satisfies
        // native × effectiveFx = USD contribution, making the card hint accurate.
        const byCurrencyNative: MoneyBucket = {};
        const byCurrencyUsd: MoneyBucket = {};
        // resolveDisplayFx returns 0 (never a silent 1) when a currency's rate is unresolved;
        // track which native buckets that happened for so the summary can flag it honestly.
        let fxUnresolved = false;
        const markIfUnresolved = (cc: string, fx: number) => {
          if (cc !== "USD" && fx === 0) fxUnresolved = true;
        };

        // Opening balance is USD-denominated
        const openingBal = toMoney(s.openingBalance);
        if (openingBal.abs().gt(0.0001)) {
          addTo(byCurrencyNative, "USD", openingBal);
          addTo(byCurrencyUsd, "USD", openingBal);
        }

        for (const c of payableContainers) {
          const cc = c.currencyCode || "USD";
          const baseVal = toMoney(c.totalKg).times(toMoney(c.ratePerKg));
          const freightAmt = isSupplierPaidFreight(c) ? toMoney(c.freight) : ZERO;
          const freightCc = c.freightCurrencyCode || cc;
          const fx = resolveDisplayFx(cc, configuredFxRates[cc], c.fxRateToUsd, c.fxRateConfirmed);
          markIfUnresolved(cc, fx);

          addTo(byCurrencyNative, cc, baseVal);
          addTo(byCurrencyUsd, cc, baseVal.times(cc === "USD" ? 1 : fx));

          // Freight in its own currency bucket with its effective USD value
          if (freightAmt.gt(0)) {
            // Same-cc freight converts at container fx; cross-cc USD freight stays as USD
            // A third-currency freight converts at its own confirmed freight rate,
            // never at the container's rate (wave 13); unresolved when it has none.
            const freightFx =
              freightCc === "USD"
                ? 1
                : (configuredFxRates[freightCc] ??
                  (freightCc === cc
                    ? fx
                    : resolveDisplayFx(freightCc, undefined, c.freightFxRateToUsd, c.freightFxRateConfirmed)));
            markIfUnresolved(freightCc, freightFx);
            addTo(byCurrencyNative, freightCc, freightAmt);
            addTo(byCurrencyUsd, freightCc, freightAmt.times(freightCc === "USD" ? 1 : freightFx));
          }

          // Commission from own containers
          const commAmt = toMoney(c.commissionAmount);
          if (commAmt.gt(0)) {
            const commCc = c.commissionCurrencyCode || cc;
            if (!(s.parentId && commCc === "USD")) {
              const commFx =
                commCc === "USD"
                  ? 1
                  : (configuredFxRates[commCc] ??
                    (commCc === cc
                      ? fx
                      : resolveDisplayFx(commCc, undefined, c.commissionFxRateToUsd, c.commissionFxRateConfirmed)));
              markIfUnresolved(commCc, commFx);
              addTo(byCurrencyNative, commCc, commAmt);
              addTo(byCurrencyUsd, commCc, commAmt.times(commCc === "USD" ? 1 : commFx));
            }
          }
        }

        // Subtract regular payments — use actual amountUsd for USD tracking
        for (const p of supplierPayments) {
          const cc = p.currencyCode || "USD";
          addTo(byCurrencyNative, cc, toMoney(p.amount).negated());
          addTo(byCurrencyUsd, cc, toMoney(p.amountUsd).negated());
        }

        // Subtract voucher-based payments — use actual USD amounts
        const voucherCurrMap = voucherPaidBySupplierCurrency[s.id] || {};
        const voucherCurrMapUsd = voucherPaidBySupplierCurrencyUsd[s.id] || {};
        for (const [cc, amt] of Object.entries(voucherCurrMap)) {
          addTo(byCurrencyNative, cc, amt.negated());
          addTo(byCurrencyUsd, cc, (voucherCurrMapUsd[cc] ?? ZERO).negated());
        }

        // FX transfers — use toAmountUsd as the settled USD value for both directions
        for (const t of allFxTransfers) {
          if (t.fromSupplierId === s.id) {
            const cc = t.fromCurrencyCode || "USD";
            addTo(byCurrencyNative, cc, toMoney(t.fromAmount).negated());
            addTo(byCurrencyUsd, cc, toMoney(t.toAmountUsd).negated());
          }
          if (t.toSupplierId === s.id) {
            addTo(byCurrencyNative, "USD", toMoney(t.toAmountUsd));
            addTo(byCurrencyUsd, "USD", toMoney(t.toAmountUsd));
          }
        }

        // Other charges attributed to this supplier (container-column otherCharges)
        for (const c of containers.filter(isPayableContainer)) {
          if (c.otherChargesSupplierId !== s.id) continue;
          const oc = toMoney(c.otherCharges);
          if (oc.lte(0)) continue;
          const cc = c.otherChargesCurrencyCode || "USD";
          if (s.parentId && cc === "USD") continue;
          // The container's rate converts only the container's own currency (wave 13).
          const sameAsContainer = cc === (c.currencyCode || "USD");
          const fx = resolveDisplayFx(
            cc,
            configuredFxRates[cc],
            sameAsContainer ? c.fxRateToUsd : undefined,
            sameAsContainer ? c.fxRateConfirmed : undefined
          );
          markIfUnresolved(cc, fx);
          addTo(byCurrencyNative, cc, oc);
          addTo(byCurrencyUsd, cc, oc.times(fx));
        }

        // Post-offload additional charges explicitly assigned to this supplier
        for (const oc of allOffloadAdditionalCharges) {
          if (oc.supplierId !== s.id) continue;
          const amt = toMoney(oc.amount);
          if (amt.lte(0)) continue;
          const cc = oc.currencyCode || "USD";
          const fx = resolveDisplayFx(cc, configuredFxRates[cc], oc.fxRateToUsd, undefined);
          markIfUnresolved(cc, fx);
          addTo(byCurrencyNative, cc, amt);
          addTo(byCurrencyUsd, cc, amt.times(fx));
        }

        // The rate each native bucket converts at: the user-configured display
        // rate (from Net Position settings) when there is one, else the
        // effective rate derived from transactions (usd / native).
        const bucketRate = (cc: string, native: Decimal): Decimal => {
          if (cc === "USD") return toMoney(1);
          if (configuredFxRates[cc] !== undefined) return toMoney(configuredFxRates[cc]);
          return native.abs().gt(0.001) ? (byCurrencyUsd[cc] ?? ZERO).dividedBy(native) : ZERO;
        };

        // Balance = sum of each native-currency bucket × its configured rate.
        // This ensures balance always equals EUR_native × configuredEurRate (etc.),
        // so the card hint and the balance number are always consistent.
        const balance = Object.entries(byCurrencyNative).reduce(
          (sum, [cc, native]) => sum.plus(native.times(bucketRate(cc, native))),
          ZERO
        );

        const currencyBuckets = Object.entries(byCurrencyNative)
          .filter(([, native]) => native.abs().gt(0.001))
          .map(([currencyCode, native]) => ({
            currencyCode,
            balance: native,
            fxRateToUsd: bucketRate(currencyCode, native),
          }))
          .sort((a, _b) => (a.currencyCode === "USD" ? 1 : -1)); // non-USD first
        const currencyBalances = currencyBuckets.map((b) => ({
          currencyCode: b.currencyCode,
          balance: b.balance.toNumber(),
          fxRateToUsd: b.fxRateToUsd.toNumber(),
        }));

        // Due containers: offloaded >30 days ago and supplier still has a positive balance
        const now = new Date();
        const dueContainers = balance.gt(0.01)
          ? payableContainers
              .filter((c): c is typeof c & { fxRateDateOffload: string } => {
                if (!c.fxRateDateOffload) return false;
                const offloadMs = new Date(c.fxRateDateOffload).getTime();
                return now.getTime() - offloadMs >= 30 * 24 * 60 * 60 * 1000;
              })
              .map((c) => ({
                id: c.id,
                containerNumber: c.containerNumber,
                offloadDate: c.fxRateDateOffload,
                currencyCode: c.currencyCode || "USD",
                value: receivedValue(c).toFixed(2),
                daysPastDue:
                  Math.floor((now.getTime() - new Date(c.fxRateDateOffload).getTime()) / (24 * 60 * 60 * 1000)) - 30,
              }))
          : [];

        // Approx FX rate: weighted average rate across non-USD containers (for UI display).
        // Only include containers whose rate is actually confirmed/resolved — a numeric
        // fxRateToUsd of exactly 1 that isn't confirmed is not a "looks set" rate.
        const fxContainers = payableContainers.filter((c) => {
          if ((c.currencyCode || "USD") === "USD") return false;
          const { looksSet } = resolveStoredFxRate(c.currencyCode, c.fxRateToUsd, c.fxRateConfirmed);
          return looksSet;
        });
        // fxContainers was already filtered to looksSet===true rows above, so each rate
        // is guaranteed resolved — resolve it through the same helper rather than a bare
        // "|| 1" fallback (which would silently mask a bug if that filter is ever loosened).
        const fxWeightedSum = fxContainers.reduce(
          (sum, c) =>
            sum.plus(
              receivedValue(c).times(resolveStoredFxRate(c.currencyCode, c.fxRateToUsd, c.fxRateConfirmed).fxRate)
            ),
          ZERO
        );
        const fxWeightBase = sumMoney(fxContainers.map(receivedValue));
        const approxFxRate = fxWeightBase.gt(0) ? fxWeightedSum.dividedBy(fxWeightBase) : ZERO;

        // Cross-currency freight that auto-flows into the broker pool for linked suppliers.
        // e.g. USD freight on an AUD container for a supplier whose parent is a broker.
        // This amount is "auto-settled" from the supplier's perspective — the broker absorbs it.
        const autoSettledFreightUsd =
          s.parentId !== null && s.parentId !== undefined
            ? sumMoney(
                payableContainers
                  .filter(
                    (c) =>
                      isSupplierPaidFreight(c) &&
                      (c.freightCurrencyCode || c.currencyCode || "USD") === "USD" &&
                      (c.currencyCode || "USD") !== "USD"
                  )
                  .map((c) => c.freight)
              )
            : ZERO;

        return {
          totalContainers,
          totalKg,
          commissionValue,
          pendingContainers,
          otwByCurrency,
          receivedContainers,
          lastContainerDate,
          totalPaid,
          balance,
          currencyBalances,
          currencyBuckets,
          dueContainers,
          approxFxRate,
          autoSettledFreightUsd,
          fxUnresolved: fxUnresolved || voucherFxUnresolvedSuppliers.has(s.id),
        };
      };

      // First pass: compute each supplier's own stats
      const statsById: Record<number, ReturnType<typeof computeStats>> = {};
      for (const s of suppliersList) {
        statsById[s.id] = computeStats(s, includeOtw);
      }

      // Pre-compute broker statements for each broker parent so the list card
      // balance matches the detail page exactly (same data source).
      const brokerParentIds = new Set<number>(
        suppliersList.filter((s) => suppliersList.some((c) => c.parentId === s.id)).map((s) => s.id as number)
      );
      const brokerStmtMap: Record<number, NonNullable<Awaited<ReturnType<typeof buildBrokerStatement>>>> = {};
      for (const s of suppliersList) {
        if (brokerParentIds.has(s.id)) {
          const stmt = await buildBrokerStatement(s.id, companyId, includeOtw);
          if (stmt) brokerStmtMap[s.id] = stmt;
        }
      }

      // Second pass: for parent suppliers, roll up children's stats
      const suppliersWithBalances = suppliersList.map((s) => {
        const own = statsById[s.id];
        const children = suppliersList.filter((c) => c.parentId === s.id);

        if (children.length === 0) {
          // Leaf supplier — use own stats
          return {
            ...s,
            totalContainers: own.totalContainers,
            totalKg: own.totalKg.toFixed(3),
            totalPaid: own.totalPaid.toFixed(2),
            totalCommissionUsd: own.commissionValue.toFixed(2),
            approxFxRate: own.approxFxRate.gt(0) ? own.approxFxRate.toFixed(4) : null,
            pendingContainers: own.pendingContainers,
            otwByCurrency: own.otwByCurrency,
            receivedContainers: own.receivedContainers,
            lastContainerDate: own.lastContainerDate,
            dueContainers: own.dueContainers,
            dueContainersCount: own.dueContainers.length,
            autoSettledFreightUsd: own.autoSettledFreightUsd.toFixed(2),
            ...ledgerFields(s.id),
            operationalMemo: {
              label: FACTORY_SUPPLIER_OPERATIONAL_MEMO_LABEL,
              totalValue: own.balance.toFixed(2),
              currencyBalances: own.currencyBalances,
              fxUnresolved: own.fxUnresolved,
            },
          };
        }

        // TRUE BROKER BALANCE MODEL — parent supplier (broker) aggregation:
        // The broker's own balance (totalValue / currencyBalances) reflects ONLY direct broker entries
        // and explicit FX-in transfers. Linked supplier balances are NOT merged into broker-owned totals.
        // They are returned separately as linkedSupplierExposure for informational display.
        const childStats = children.map((c) => statsById[c.id]);
        // Informational aggregates that span all parties (container counts, kg, dates)
        const aggContainers = own.totalContainers + childStats.reduce((n: number, cs) => n + cs.totalContainers, 0);
        const aggKg = own.totalKg.plus(sumMoney(childStats.map((cs) => cs.totalKg)));
        const aggPending = own.pendingContainers + childStats.reduce((n: number, cs) => n + cs.pendingContainers, 0);
        const aggOtwByCurrency: Record<string, number> = { ...own.otwByCurrency };
        for (const cs of childStats) {
          for (const [cc, n] of Object.entries(cs.otwByCurrency || {})) {
            aggOtwByCurrency[cc] = (aggOtwByCurrency[cc] || 0) + (n as number);
          }
        }
        const aggReceived = own.receivedContainers + childStats.reduce((n: number, cs) => n + cs.receivedContainers, 0);
        const allDates = [own.lastContainerDate, ...childStats.map((cs) => cs.lastContainerDate)].filter(
          (d): d is string => typeof d === "string"
        );
        const aggLastDate =
          allDates.length > 0 ? allDates.reduce((latest, d) => (new Date(d) > new Date(latest) ? d : latest)) : null;
        const aggDueContainers = [...own.dueContainers, ...childStats.flatMap((cs) => cs.dueContainers)];

        // Linked supplier exposure: per-child per-currency balances (informational, NOT counted in broker totals)
        const linkedSupplierExposure = children.map((c, i: number) => {
          const childLedger = ledgerFields(c.id);
          return {
            supplierId: c.id,
            supplierName: c.name,
            ledgerBalance: childLedger.ledgerBalance,
            currencyBalances: childLedger.currencyBalances,
            notInLedgerTotal: childLedger.notInLedgerTotal,
            operationalCurrencyBalances: childStats[i].currencyBalances,
            autoSettledFreightUsd: childStats[i].autoSettledFreightUsd.toFixed(2),
          };
        });

        // Aggregate exposure totals for summary display (informational only).
        // Auto-settled cross-currency freight (e.g. USD freight on AUD containers) flows into
        // the broker's own USD pool automatically — exclude it from the linked exposure aggregate
        // so it doesn't appear as an unresolved obligation.
        const exposureCurrencyMap: MoneyBucket = {};
        const exposureFxMap: Record<string, { wSum: Decimal; vSum: Decimal }> = {};
        for (const cs of childStats) {
          for (const cb of cs.currencyBuckets) {
            // For USD balances on a linked supplier, subtract auto-settled freight so the broker
            // card doesn't show it as an open exposure (it's already in the broker pool).
            const effectiveBal = cb.currencyCode === "USD" ? cb.balance.minus(cs.autoSettledFreightUsd) : cb.balance;
            if (effectiveBal.gt(0)) {
              addTo(exposureCurrencyMap, cb.currencyCode, effectiveBal);
              if (cb.currencyCode !== "USD" && cb.fxRateToUsd.gt(0)) {
                const fxEntry = (exposureFxMap[cb.currencyCode] ??= { wSum: ZERO, vSum: ZERO });
                fxEntry.wSum = fxEntry.wSum.plus(effectiveBal.times(cb.fxRateToUsd));
                fxEntry.vSum = fxEntry.vSum.plus(effectiveBal);
              }
            }
          }
        }
        const exposureCurrencyBalances = Object.entries(exposureCurrencyMap)
          .filter(([, bal]) => bal.gt(0.001))
          .map(([currencyCode, bal]) => {
            const fxEntry = exposureFxMap[currencyCode];
            return {
              currencyCode,
              balance: bal,
              fxRateToUsd: fxEntry?.vSum.gt(0) ? fxEntry.wSum.dividedBy(fxEntry.vSum) : toMoney(1),
            };
          })
          .sort((a, _b) => (a.currencyCode === "USD" ? 1 : -1));

        // Use broker-statement KPIs so the list card total matches the detail page.
        // Formula: USD_pool + EUR × configuredRate + AUD × configuredRate = totalValue
        const stmt = brokerStmtMap[s.id];
        let brokerPoolUsd: Decimal = own.balance;
        let finalExposureCurrencyBalances = exposureCurrencyBalances;

        if (stmt) {
          const eurLedger = stmt.currencyLedgers.find((l) => l.currencyCode === "EUR");
          const audLedger = stmt.currencyLedgers.find((l) => l.currencyCode === "AUD");
          const usdLedger = stmt.currencyLedgers.find((l) => l.currencyCode === "USD");

          const eurBal = toMoney(eurLedger?.netBalance);
          const audBal = toMoney(audLedger?.netBalance);
          brokerPoolUsd = usdLedger ? toMoney(usdLedger.netBalance) : own.balance;

          // No silent default to 1 for an unconfigured company-level rate — leave unresolved (0)
          // so the exposure total below excludes it rather than guessing.
          const eurRate = configuredFxRates["EUR"] ?? 0;
          const audRate = configuredFxRates["AUD"] ?? 0;

          finalExposureCurrencyBalances = [
            ...(eurBal.abs().gt(0.001)
              ? [{ currencyCode: "EUR", balance: eurBal, fxRateToUsd: toMoney(eurRate) }]
              : []),
            ...(audBal.abs().gt(0.001)
              ? [{ currencyCode: "AUD", balance: audBal, fxRateToUsd: toMoney(audRate) }]
              : []),
          ];
        }

        const grandTotal = finalExposureCurrencyBalances.reduce(
          (sum, e) => sum.plus(e.currencyCode === "USD" ? e.balance : e.balance.times(e.fxRateToUsd)),
          brokerPoolUsd
        );

        const brokerLedger = ledgerFields(s.id);
        return {
          ...s,
          totalContainers: aggContainers,
          totalKg: aggKg.toFixed(3),
          // The broker's own ledger balance (true broker model: linked suppliers
          // are not merged in; they are listed in linkedSupplierExposure).
          ...brokerLedger,
          brokerPoolUsd: brokerLedger.ledgerBalance,
          totalPaid: own.totalPaid.toFixed(2),
          totalCommissionUsd: own.commissionValue.toFixed(2),
          approxFxRate: own.approxFxRate.gt(0) ? own.approxFxRate.toFixed(4) : null,
          pendingContainers: aggPending,
          otwByCurrency: aggOtwByCurrency,
          receivedContainers: aggReceived,
          lastContainerDate: aggLastDate,
          dueContainers: aggDueContainers,
          dueContainersCount: aggDueContainers.length,
          linkedSupplierExposure,
          // Linked suppliers' ledger balances per currency (what they are owed), informational.
          exposureCurrencyBalances: ledgerExposure(children.map((c) => c.id)),
          fxUnresolved: brokerLedger.fxUnresolved || children.some((c) => ledgerFields(c.id).fxUnresolved),
          operationalMemo: {
            label: FACTORY_SUPPLIER_OPERATIONAL_MEMO_LABEL,
            // Grand total: USD_pool + EUR × rate + AUD × rate (the broker statement's KPI).
            totalValue: grandTotal.toFixed(2),
            brokerPoolUsd: brokerPoolUsd.toFixed(2),
            currencyBalances: own.currencyBalances,
            exposureCurrencyBalances: finalExposureCurrencyBalances.map((e) => ({
              currencyCode: e.currencyCode,
              balance: e.balance.toNumber(),
              fxRateToUsd: e.fxRateToUsd.toNumber(),
            })),
            fxUnresolved: own.fxUnresolved || childStats.some((cs) => cs.fxUnresolved),
          },
        };
      });

      res.json(suppliersWithBalances.sort((a, b) => a.name.localeCompare(b.name)));
    } catch (error: unknown) {
      logger.error("Error fetching factory suppliers with balances:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
