// Extracted from ./with-balances.ts to keep that module under the source-size cap.
import { resolveStoredFxRate } from "../../../../services/factory/currencyConversion";
import { sumMoney, toMoney } from "../../../../lib/money";
import type Decimal from "decimal.js";
import { factorySuppliers } from "@shared/schema";
import { isPayableContainer, isSupplierPaidFreight, resolveDisplayFx } from "./_helpers";
import {
  ZERO,
  addTo,
  handleGetFactorySuppliersWithBalancesStep1,
  receivedValue,
  type MoneyBucket,
} from "./handleGetFactorySuppliersWithBalancesStep1";

export function handleGetFactorySuppliersWithBalancesStep2({
  allFxTransfers,
  allOffloadAdditionalCharges,
  allPayments,
  configuredFxRates,
  containers,
  voucherFxUnresolvedSuppliers,
  voucherPaidBySupplierCurrency,
  voucherPaidBySupplierCurrencyUsd,
}: Pick<
  Extract<Awaited<ReturnType<typeof handleGetFactorySuppliersWithBalancesStep1>>, { done: false }>,
  | "allFxTransfers"
  | "allOffloadAdditionalCharges"
  | "allPayments"
  | "configuredFxRates"
  | "containers"
  | "voucherFxUnresolvedSuppliers"
  | "voucherPaidBySupplierCurrency"
  | "voucherPaidBySupplierCurrencyUsd"
>) {
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
        sum.plus(receivedValue(c).times(resolveStoredFxRate(c.currencyCode, c.fxRateToUsd, c.fxRateConfirmed).fxRate)),
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
  return { computeStats };
}
