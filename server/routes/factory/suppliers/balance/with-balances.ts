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
      const voucherPaidBySupplier: Record<number, number> = {};
      const voucherFxUnresolvedSuppliers = new Set<number>();
      const voucherPaidBySupplierCurrency: Record<number, Record<string, number>> = {};
      const voucherPaidBySupplierCurrencyUsd: Record<number, Record<string, number>> = {};
      if (allSupplierIds.length > 0) {
        const voucherPaymentRows = await db
          .select({
            factorySupplierId: voucherEntries.factorySupplierId,
            debitAmount: voucherEntries.debitAmount,
            currency: vouchers.currency,
            exchangeRate: vouchers.exchangeRate,
            optional: vouchers.optional,
          })
          .from(voucherEntries)
          .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
          .where(
            and(
              inArray(voucherEntries.factorySupplierId, allSupplierIds),
              sql`${voucherEntries.debitAmount}::numeric > 0`,
              sql`${vouchers.voucherNumber} NOT LIKE 'FACTORY-PAY-%'`
            )
          );
        for (const row of voucherPaymentRows) {
          const suppId = row.factorySupplierId;
          if (!suppId) continue;
          if (row.optional) continue; // optional vouchers don't affect the balance
          const amt = parseFloat(row.debitAmount || "0");
          const curr = row.currency || "USD";
          let usdAmt: number;
          if (curr === "USD") {
            usdAmt = amt;
          } else {
            // vouchers.exchangeRate has no fxRateConfirmed column yet — legacy heuristic stopgap.
            const { fxRate: fx, looksSet } = resolveStoredFxRate(curr, row.exchangeRate);
            if (!looksSet) {
              voucherFxUnresolvedSuppliers.add(suppId);
              continue; // exclude from the total rather than guess at 1
            }
            usdAmt = amt / fx;
          }
          voucherPaidBySupplier[suppId] = (voucherPaidBySupplier[suppId] || 0) + usdAmt;
          if (!voucherPaidBySupplierCurrency[suppId]) voucherPaidBySupplierCurrency[suppId] = {};
          voucherPaidBySupplierCurrency[suppId][curr] = (voucherPaidBySupplierCurrency[suppId][curr] || 0) + amt;
          if (!voucherPaidBySupplierCurrencyUsd[suppId]) voucherPaidBySupplierCurrencyUsd[suppId] = {};
          voucherPaidBySupplierCurrencyUsd[suppId][curr] =
            (voucherPaidBySupplierCurrencyUsd[suppId][curr] || 0) + usdAmt;
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
        configuredFxRates[row.currency_code] = parseFloat(row.rate_to_usd);
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

      // Helper to compute stats for a single supplier record
      const computeStats = (s: typeof factorySuppliers.$inferSelect, includeOtw: boolean = false) => {
        const supplierContainers = containers.filter((c) => c.supplierId === s.id);
        const payableContainers = supplierContainers.filter(
          (c) => isPayableContainer(c) || (includeOtw && (c.status === "PENDING" || c.status === "IN_TRANSIT"))
        );
        const totalContainers = supplierContainers.length;
        const totalKg = supplierContainers.reduce((sum: number, c) => {
          return sum + parseFloat(c.actualReceivedKg || c.totalKg || "0");
        }, 0);
        // Sum container value including freight (agreed supplier charge) in USD.
        // Cross-currency freight (e.g. USD freight on AUD containers) is added directly in USD.
        // Always prefer the user-configured FX rate; fall back to the per-container rate only
        // when no configured rate exists for that currency.
        const containerValue = payableContainers.reduce((sum: number, c) => {
          // Use totalKg (declared/agreed weight) not actualReceivedKg — weight differences
          // at offload affect inventory only, not what is owed to the supplier.
          const kg = parseFloat(c.totalKg || "0");
          const rate = parseFloat(c.ratePerKg || "0");
          const freight = isSupplierPaidFreight(c) ? parseFloat(c.freight || "0") : 0;
          const containerCc = c.currencyCode || "USD";
          const fx = resolveDisplayFx(containerCc, configuredFxRates[containerCc], c.fxRateToUsd, c.fxRateConfirmed);
          const freightCc = c.freightCurrencyCode || containerCc;
          const _freightFx = configuredFxRates[freightCc] ?? fx;
          const freightInContainerCurr = freightCc === containerCc ? freight : 0;
          const freightDirectUsd = freightCc === "USD" && freightCc !== containerCc ? freight : 0;
          return sum + (kg * rate + freightInContainerCurr) * fx + freightDirectUsd;
        }, 0);
        // Commission accumulates under the supplier, EXCEPT:
        // if this supplier is linked to a broker (has parentId), USD commission flows to the broker.
        const commissionValue = payableContainers.reduce((sum: number, c) => {
          const commAmt = parseFloat(c.commissionAmount || "0");
          if (commAmt <= 0) return sum;
          const commCurr = c.commissionCurrencyCode || c.currencyCode || "USD";
          // Linked supplier: USD commission is absorbed by the parent broker — skip here
          if (s.parentId && commCurr === "USD") return sum;
          const commFx = resolveDisplayFx(
            commCurr,
            configuredFxRates[commCurr],
            commCurr === (c.currencyCode || "USD") ? c.fxRateToUsd : undefined,
            commCurr === (c.currencyCode || "USD") ? c.fxRateConfirmed : undefined
          );
          return sum + (commCurr === "USD" ? commAmt : commAmt * commFx);
        }, 0);
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
        const supplierPayments = allPayments.filter((p: { id: number; companyId: number; supplierId: number; date: string; amount: string; currencyCode: string; fxRateToUsd: string; amountUsd: string; paidFromAccountId: number | null; notes: string | null; createdAt: Date; }) => p.supplierId === s.id);
        const totalPaid = supplierPayments.reduce((sum: number, p: { id: number; companyId: number; supplierId: number; date: string; amount: string; currencyCode: string; fxRateToUsd: string; amountUsd: string; paidFromAccountId: number | null; notes: string | null; createdAt: Date; }) => sum + parseFloat(p.amountUsd || "0"), 0);
        // Include voucher-based payments (payment vouchers) in the balance
        const _voucherPaidUsd = voucherPaidBySupplier[s.id] || 0;
        // FX net (USD): FX-in transfers received minus FX-out transfers sent (in USD equivalent)
        // This is critical for brokers that accumulate balance via explicit FX settlements from linked suppliers.
        // Always use toAmountUsd as the USD amount — it reflects the actual settled USD value.
        let _fxNetUsd = 0;
        for (const t of allFxTransfers) {
          if (t.toSupplierId === s.id) {
            _fxNetUsd += parseFloat(t.toAmountUsd || "0");
          }
          if (t.fromSupplierId === s.id) {
            _fxNetUsd -= parseFloat(t.toAmountUsd || "0");
          }
        }
        // Other charges from containers where this supplier is the charge recipient.
        // Linked suppliers: USD other charges flow to the parent broker — exclude from own balance.
        const _otherChargesValue = containers.filter(isPayableContainer).reduce((sum: number, c) => {
          if (c.otherChargesSupplierId !== s.id) return sum;
          const oc = parseFloat(c.otherCharges || "0");
          if (oc <= 0) return sum;
          const ocCcy = c.otherChargesCurrencyCode || "USD";
          if (s.parentId && ocCcy === "USD") return sum;
          const fx = resolveDisplayFx(ocCcy, configuredFxRates[ocCcy], c.fxRateToUsd, c.fxRateConfirmed);
          return sum + oc * fx;
        }, 0);
        // Per-currency balances (original currency, not converted).
        // Track both native amount AND USD equivalent for every transaction so that
        // fxRateToUsd = usdSum / nativeSum — an effective rate that always satisfies
        // native × effectiveFx = USD contribution, making the card hint accurate.
        const byCurrencyNative: Record<string, number> = {};
        const byCurrencyUsd: Record<string, number> = {};
        // resolveDisplayFx returns 0 (never a silent 1) when a currency's rate is unresolved;
        // track which native buckets that happened for so the summary can flag it honestly.
        let fxUnresolved = false;
        const markIfUnresolved = (cc: string, fx: number) => {
          if (cc !== "USD" && fx === 0) fxUnresolved = true;
        };

        // Opening balance is USD-denominated
        const openingBal = parseFloat(s.openingBalance || "0");
        if (Math.abs(openingBal) > 0.0001) {
          byCurrencyNative["USD"] = (byCurrencyNative["USD"] || 0) + openingBal;
          byCurrencyUsd["USD"] = (byCurrencyUsd["USD"] || 0) + openingBal;
        }

        for (const c of payableContainers) {
          const cc = c.currencyCode || "USD";
          const baseVal = parseFloat(c.totalKg || "0") * parseFloat(c.ratePerKg || "0");
          const freightAmt = isSupplierPaidFreight(c) ? parseFloat(c.freight || "0") : 0;
          const freightCc = c.freightCurrencyCode || cc;
          const fx = resolveDisplayFx(cc, configuredFxRates[cc], c.fxRateToUsd, c.fxRateConfirmed);
          markIfUnresolved(cc, fx);

          byCurrencyNative[cc] = (byCurrencyNative[cc] || 0) + baseVal;
          byCurrencyUsd[cc] = (byCurrencyUsd[cc] || 0) + baseVal * (cc === "USD" ? 1 : fx);

          // Freight in its own currency bucket with its effective USD value
          if (freightAmt > 0) {
            // Same-cc freight converts at container fx; cross-cc USD freight stays as USD
            const freightFx =
              freightCc === "USD"
                ? 1
                : (configuredFxRates[freightCc] ??
                  (freightCc === cc ? fx : resolveDisplayFx(freightCc, undefined, c.fxRateToUsd, c.fxRateConfirmed)));
            markIfUnresolved(freightCc, freightFx);
            byCurrencyNative[freightCc] = (byCurrencyNative[freightCc] || 0) + freightAmt;
            byCurrencyUsd[freightCc] =
              (byCurrencyUsd[freightCc] || 0) + freightAmt * (freightCc === "USD" ? 1 : freightFx);
          }

          // Commission from own containers
          const commAmt = parseFloat(c.commissionAmount || "0");
          if (commAmt > 0) {
            const commCc = c.commissionCurrencyCode || cc;
            if (!(s.parentId && commCc === "USD")) {
              const commFx =
                commCc === "USD"
                  ? 1
                  : (configuredFxRates[commCc] ??
                    (commCc === cc ? fx : resolveDisplayFx(commCc, undefined, c.fxRateToUsd, c.fxRateConfirmed)));
              markIfUnresolved(commCc, commFx);
              byCurrencyNative[commCc] = (byCurrencyNative[commCc] || 0) + commAmt;
              byCurrencyUsd[commCc] = (byCurrencyUsd[commCc] || 0) + commAmt * (commCc === "USD" ? 1 : commFx);
            }
          }
        }

        // Subtract regular payments — use actual amountUsd for USD tracking
        for (const p of supplierPayments) {
          const cc = p.currencyCode || "USD";
          byCurrencyNative[cc] = (byCurrencyNative[cc] || 0) - parseFloat(p.amount || "0");
          byCurrencyUsd[cc] = (byCurrencyUsd[cc] || 0) - parseFloat(p.amountUsd || "0");
        }

        // Subtract voucher-based payments — use actual USD amounts
        const voucherCurrMap = voucherPaidBySupplierCurrency[s.id] || {};
        const voucherCurrMapUsd = voucherPaidBySupplierCurrencyUsd[s.id] || {};
        for (const [cc, amt] of Object.entries(voucherCurrMap)) {
          byCurrencyNative[cc] = (byCurrencyNative[cc] || 0) - amt;
          byCurrencyUsd[cc] = (byCurrencyUsd[cc] || 0) - (voucherCurrMapUsd[cc] || 0);
        }

        // FX transfers — use toAmountUsd as the settled USD value for both directions
        for (const t of allFxTransfers) {
          if (t.fromSupplierId === s.id) {
            const cc = t.fromCurrencyCode || "USD";
            byCurrencyNative[cc] = (byCurrencyNative[cc] || 0) - parseFloat(t.fromAmount || "0");
            byCurrencyUsd[cc] = (byCurrencyUsd[cc] || 0) - parseFloat(t.toAmountUsd || "0");
          }
          if (t.toSupplierId === s.id) {
            byCurrencyNative["USD"] = (byCurrencyNative["USD"] || 0) + parseFloat(t.toAmountUsd || "0");
            byCurrencyUsd["USD"] = (byCurrencyUsd["USD"] || 0) + parseFloat(t.toAmountUsd || "0");
          }
        }

        // Other charges attributed to this supplier (container-column otherCharges)
        for (const c of containers.filter(isPayableContainer)) {
          if (c.otherChargesSupplierId !== s.id) continue;
          const oc = parseFloat(c.otherCharges || "0");
          if (oc <= 0) continue;
          const cc = c.otherChargesCurrencyCode || "USD";
          if (s.parentId && cc === "USD") continue;
          const fx = resolveDisplayFx(cc, configuredFxRates[cc], c.fxRateToUsd, c.fxRateConfirmed);
          markIfUnresolved(cc, fx);
          byCurrencyNative[cc] = (byCurrencyNative[cc] || 0) + oc;
          byCurrencyUsd[cc] = (byCurrencyUsd[cc] || 0) + oc * fx;
        }

        // Post-offload additional charges explicitly assigned to this supplier
        for (const oc of allOffloadAdditionalCharges) {
          if (oc.supplierId !== s.id) continue;
          const amt = parseFloat(oc.amount || "0");
          if (amt <= 0) continue;
          const cc = oc.currencyCode || "USD";
          const fx = resolveDisplayFx(cc, configuredFxRates[cc], oc.fxRateToUsd, undefined);
          markIfUnresolved(cc, fx);
          byCurrencyNative[cc] = (byCurrencyNative[cc] || 0) + amt;
          byCurrencyUsd[cc] = (byCurrencyUsd[cc] || 0) + amt * fx;
        }

        // Balance = sum of each native-currency bucket × its configured rate.
        // This ensures balance always equals EUR_native × configuredEurRate (etc.),
        // so the card hint and the balance number are always consistent.
        const balance = Object.entries(byCurrencyNative).reduce((sum, [cc, native]) => {
          const usd = byCurrencyUsd[cc] || 0;
          const effectiveFx = cc === "USD" ? 1 : Math.abs(native) > 0.001 ? usd / native : 0;
          const rate = cc === "USD" ? 1 : (configuredFxRates[cc] ?? effectiveFx);
          return sum + native * rate;
        }, 0);

        // Use the user-configured display rate (from Net Position settings) if available,
        // falling back to the effective rate derived from transactions.
        const currencyBalances = Object.entries(byCurrencyNative)
          .map(([currencyCode, native]) => {
            const usd = byCurrencyUsd[currencyCode] || 0;
            const effectiveFx = currencyCode === "USD" ? 1 : Math.abs(native) > 0.001 ? usd / native : 0;
            const displayFx = currencyCode === "USD" ? 1 : (configuredFxRates[currencyCode] ?? effectiveFx);
            return { currencyCode, balance: native, fxRateToUsd: displayFx };
          })
          .filter(({ balance: bal }) => Math.abs(bal) > 0.001)
          .sort((a, _b) => (a.currencyCode === "USD" ? 1 : -1)); // non-USD first

        // Due containers: offloaded >30 days ago and supplier still has a positive balance
        const now = new Date();
        const dueContainers =
          balance > 0.01
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
                  value: (
                    parseFloat(c.actualReceivedKg || c.totalKg || "0") * parseFloat(c.ratePerKg || "0") +
                    (isSupplierPaidFreight(c) ? parseFloat(c.freight || "0") : 0)
                  ).toFixed(2),
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
        const fxWeightedSum = fxContainers.reduce((s: number, c) => {
          const val =
            parseFloat(c.actualReceivedKg || c.totalKg || "0") * parseFloat(c.ratePerKg || "0") +
            (isSupplierPaidFreight(c) ? parseFloat(c.freight || "0") : 0);
          // fxContainers was already filtered to looksSet===true rows above, so this rate
          // is guaranteed resolved — resolve it through the same helper rather than a bare
          // "|| 1" fallback (which would silently mask a bug if that filter is ever loosened).
          const { fxRate } = resolveStoredFxRate(c.currencyCode, c.fxRateToUsd, c.fxRateConfirmed);
          return s + val * fxRate;
        }, 0);
        const fxWeightBase = fxContainers.reduce((s: number, c) => {
          return (
            s +
            (parseFloat(c.actualReceivedKg || c.totalKg || "0") * parseFloat(c.ratePerKg || "0") +
              (isSupplierPaidFreight(c) ? parseFloat(c.freight || "0") : 0))
          );
        }, 0);
        const approxFxRate = fxWeightBase > 0 ? fxWeightedSum / fxWeightBase : 0;

        // Cross-currency freight that auto-flows into the broker pool for linked suppliers.
        // e.g. USD freight on an AUD container for a supplier whose parent is a broker.
        // This amount is "auto-settled" from the supplier's perspective — the broker absorbs it.
        const autoSettledFreightUsd =
          s.parentId !== null && s.parentId !== undefined
            ? payableContainers.reduce((sum: number, c) => {
                if (!isSupplierPaidFreight(c)) return sum;
                const freightCc = c.freightCurrencyCode || c.currencyCode || "USD";
                const containerCc = c.currencyCode || "USD";
                if (freightCc === "USD" && containerCc !== "USD") {
                  return sum + parseFloat(c.freight || "0");
                }
                return sum;
              }, 0)
            : 0;

        return {
          totalContainers,
          totalKg,
          containerValue,
          commissionValue,
          pendingContainers,
          otwByCurrency,
          receivedContainers,
          lastContainerDate,
          totalPaid,
          balance,
          currencyBalances,
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
        (suppliersList)
          .filter((s) => (suppliersList).some((c) => c.parentId === s.id))
          .map((s) => s.id as number)
      );
      const brokerStmtMap: Record<number, NonNullable<Awaited<ReturnType<typeof buildBrokerStatement>>>> = {};
      for (const s of suppliersList) {
        if (brokerParentIds.has(s.id)) {
          const stmt = await buildBrokerStatement(s.id, companyId, includeOtw);
          if (stmt) brokerStmtMap[s.id] = stmt;
        }
      }

      // Second pass: for parent suppliers, roll up children's stats
      const suppliersWithBalances = (suppliersList).map((s) => {
        const own = statsById[s.id];
        const children = (suppliersList).filter((c) => c.parentId === s.id);

        if (children.length === 0) {
          // Leaf supplier — use own stats
          return {
            ...s,
            totalContainers: own.totalContainers,
            totalKg: own.totalKg.toFixed(3),
            totalValue: own.balance.toFixed(2),
            totalPaid: own.totalPaid.toFixed(2),
            totalCommissionUsd: own.commissionValue.toFixed(2),
            approxFxRate: own.approxFxRate > 0 ? own.approxFxRate.toFixed(4) : null,
            pendingContainers: own.pendingContainers,
            otwByCurrency: own.otwByCurrency,
            receivedContainers: own.receivedContainers,
            lastContainerDate: own.lastContainerDate,
            currencyBalances: own.currencyBalances,
            dueContainers: own.dueContainers,
            dueContainersCount: own.dueContainers.length,
            autoSettledFreightUsd: own.autoSettledFreightUsd.toFixed(2),
            fxUnresolved: own.fxUnresolved,
          };
        }

        // TRUE BROKER BALANCE MODEL — parent supplier (broker) aggregation:
        // The broker's own balance (totalValue / currencyBalances) reflects ONLY direct broker entries
        // and explicit FX-in transfers. Linked supplier balances are NOT merged into broker-owned totals.
        // They are returned separately as linkedSupplierExposure for informational display.
        const childStats = children.map((c) => statsById[c.id]);
        // Informational aggregates that span all parties (container counts, kg, dates)
        const aggContainers =
          own.totalContainers + childStats.reduce((n: number, cs) => n + cs.totalContainers, 0);
        const aggKg = own.totalKg + childStats.reduce((n: number, cs) => n + cs.totalKg, 0);
        const aggPending =
          own.pendingContainers + childStats.reduce((n: number, cs) => n + cs.pendingContainers, 0);
        const aggOtwByCurrency: Record<string, number> = { ...own.otwByCurrency };
        for (const cs of childStats) {
          for (const [cc, n] of Object.entries(cs.otwByCurrency || {})) {
            aggOtwByCurrency[cc] = (aggOtwByCurrency[cc] || 0) + (n as number);
          }
        }
        const aggReceived =
          own.receivedContainers + childStats.reduce((n: number, cs) => n + cs.receivedContainers, 0);
        const allDates = [own.lastContainerDate, ...childStats.map((cs) => cs.lastContainerDate)].filter((d): d is string => typeof d === "string");
        const aggLastDate =
          allDates.length > 0
            ? allDates.reduce((latest, d) => (new Date(d) > new Date(latest) ? d : latest))
            : null;
        const aggDueContainers = [...own.dueContainers, ...childStats.flatMap((cs) => cs.dueContainers)];

        // Linked supplier exposure: per-child per-currency balances (informational, NOT counted in broker totals)
        const linkedSupplierExposure = children.map((c, i: number) => ({
          supplierId: c.id,
          supplierName: c.name,
          currencyBalances: childStats[i].currencyBalances,
          autoSettledFreightUsd: childStats[i].autoSettledFreightUsd.toFixed(2),
        }));

        // Aggregate exposure totals for summary display (informational only).
        // Auto-settled cross-currency freight (e.g. USD freight on AUD containers) flows into
        // the broker's own USD pool automatically — exclude it from the linked exposure aggregate
        // so it doesn't appear as an unresolved obligation.
        const exposureCurrencyMap: Record<string, number> = {};
        const exposureFxMap: Record<string, { wSum: number; vSum: number }> = {};
        for (const cs of childStats) {
          const autoFreight = cs.autoSettledFreightUsd || 0;
          for (const cb of cs.currencyBalances) {
            // For USD balances on a linked supplier, subtract auto-settled freight so the broker
            // card doesn't show it as an open exposure (it's already in the broker pool).
            const effectiveBal = cb.currencyCode === "USD" ? cb.balance - autoFreight : cb.balance;
            if (effectiveBal > 0) {
              exposureCurrencyMap[cb.currencyCode] = (exposureCurrencyMap[cb.currencyCode] || 0) + effectiveBal;
              if (cb.currencyCode !== "USD" && cb.fxRateToUsd && cb.fxRateToUsd > 0) {
                if (!exposureFxMap[cb.currencyCode]) exposureFxMap[cb.currencyCode] = { wSum: 0, vSum: 0 };
                exposureFxMap[cb.currencyCode].wSum += effectiveBal * cb.fxRateToUsd;
                exposureFxMap[cb.currencyCode].vSum += effectiveBal;
              }
            }
          }
        }
        const exposureCurrencyBalances = Object.entries(exposureCurrencyMap)
          .map(([currencyCode, bal]) => ({
            currencyCode,
            balance: bal,
            fxRateToUsd:
              exposureFxMap[currencyCode]?.vSum > 0
                ? exposureFxMap[currencyCode].wSum / exposureFxMap[currencyCode].vSum
                : 1,
          }))
          .filter(({ balance: bal }) => bal > 0.001)
          .sort((a, _b) => (a.currencyCode === "USD" ? 1 : -1));

        // Use broker-statement KPIs so the list card total matches the detail page.
        // Formula: USD_pool + EUR × configuredRate + AUD × configuredRate = totalValue
        const stmt = brokerStmtMap[s.id];
        let brokerPoolUsd: number = own.balance;
        let finalExposureCurrencyBalances = exposureCurrencyBalances;

        if (stmt) {
          const eurLedger = stmt.currencyLedgers.find((l) => l.currencyCode === "EUR");
          const audLedger = stmt.currencyLedgers.find((l) => l.currencyCode === "AUD");
          const usdLedger = stmt.currencyLedgers.find((l) => l.currencyCode === "USD");

          const eurBal = eurLedger ? parseFloat(eurLedger.netBalance) : 0;
          const audBal = audLedger ? parseFloat(audLedger.netBalance) : 0;
          brokerPoolUsd = usdLedger ? parseFloat(usdLedger.netBalance) : own.balance;

          // No silent default to 1 for an unconfigured company-level rate — leave unresolved (0)
          // so the exposure total below excludes it rather than guessing.
          const eurRate = configuredFxRates["EUR"] ?? 0;
          const audRate = configuredFxRates["AUD"] ?? 0;

          finalExposureCurrencyBalances = [
            ...(Math.abs(eurBal) > 0.001 ? [{ currencyCode: "EUR", balance: eurBal, fxRateToUsd: eurRate }] : []),
            ...(Math.abs(audBal) > 0.001 ? [{ currencyCode: "AUD", balance: audBal, fxRateToUsd: audRate }] : []),
          ];
        }

        const grandTotal =
          brokerPoolUsd +
          finalExposureCurrencyBalances.reduce((sum, e) => {
            if (e.currencyCode === "USD") return sum + e.balance;
            return sum + e.balance * (e.fxRateToUsd ?? 1);
          }, 0);

        return {
          ...s,
          totalContainers: aggContainers,
          totalKg: aggKg.toFixed(3),
          // Grand total: USD_pool + EUR × rate + AUD × rate (matches detail page)
          totalValue: grandTotal.toFixed(2),
          brokerPoolUsd: brokerPoolUsd.toFixed(2),
          totalPaid: own.totalPaid.toFixed(2),
          totalCommissionUsd: own.commissionValue.toFixed(2),
          approxFxRate: own.approxFxRate > 0 ? own.approxFxRate.toFixed(4) : null,
          pendingContainers: aggPending,
          otwByCurrency: aggOtwByCurrency,
          receivedContainers: aggReceived,
          lastContainerDate: aggLastDate,
          currencyBalances: own.currencyBalances,
          dueContainers: aggDueContainers,
          dueContainersCount: aggDueContainers.length,
          linkedSupplierExposure,
          exposureCurrencyBalances: finalExposureCurrencyBalances,
          fxUnresolved: own.fxUnresolved || childStats.some((cs) => cs.fxUnresolved),
        };
      });

      res.json(suppliersWithBalances.sort((a, b) => a.name.localeCompare(b.name)));
    } catch (error: unknown) {
      logger.error("Error fetching factory suppliers with balances:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
