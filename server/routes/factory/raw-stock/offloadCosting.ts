import Decimal from "decimal.js";

import { factoryContainerCommissions } from "@shared/schema";

import { getErrorMessage } from "../../../lib/httpHandlers";
import { computeContainerLandedCost } from "../../../services/factory/containerLandedCost";
import { getOrFetchFxRateToUsd, getOrCreateLedgerAccount } from "../_helpers";

/**
 * Everything POST /api/factory/raw-stock/offload works out before it opens its
 * transaction: the commission, the per-component USD values, the landed cost
 * from the shared helper, and the ledger accounts the posting will need.
 *
 * It is pure costing plus two account upserts — no offload writes happen here,
 * which is the point: `getOrCreateLedgerAccount` performs its own upsert on the
 * raw connection and must not run inside the transaction.
 *
 * The two request-rejecting paths (an unresolvable commission FX rate, and a
 * charge whose rate the helper could not resolve) return a typed failure rather
 * than writing the response, so the route keeps sole ownership of `res`.
 *
 * config/report-characterization.json pins the endpoint's output across the move.
 */
/** The commission block as the offload request sends it. */
export interface OffloadCommissionInput {
  personName?: string;
  commissionType?: string;
  commissionRate?: string;
  currencyCode?: string;
  ledgerAccountId?: string;
}

/** One additional charge as the offload request sends it. */
export interface OffloadAdditionalChargeInput {
  amount?: string;
  currencyCode?: string;
  fxRateToUsd?: string;
}

export interface OffloadCostingContext {
  companyId: number;
  containerId: number;
  container: Record<string, unknown> & { totalKg: string | null };
  currencyCode: string;
  fxRate: number;
  offloadDate: string;
  declaredKg: string;
  dReceivedKg: Decimal;
  baseCostPerKg: string;
  commission: OffloadCommissionInput | null | undefined;
  freightVal: number;
  otherChargesVal: number;
  additionalChargesArr: OffloadAdditionalChargeInput[];
  dutyVal: number;
  dutyStatus: string;
  effectiveFreightSupplierId: number | null;
  reqFreightCurrencyCode?: string;
  reqFreightFxRate?: string;
  reqFreightAccountId?: string;
  reqOtherChargesCurrencyCode?: string;
  reqOtherChargesFxRate?: string;
  reqOtherChargesSupplierId?: string | number | null;
  reqOtherChargesAccountId?: string;
}

export type OffloadCosting =
  | { ok: false; httpStatus: number; body: { message: string } }
  | {
      ok: true;
      commTotalVal: number;
      commCurrencyForUsd: string;
      commFxRateForUsd: number;
      commInsertValues: typeof factoryContainerCommissions.$inferInsert | null;
      freightCcy: string;
      freightFxRateVal: number;
      freightUsd: number;
      ocCcy: string;
      ocFxRateVal: number;
      ocUsd: number;
      dInclusiveCostPerKg: Decimal;
      dCostPerKgUsd: Decimal;
      finalPayableAmount: string;
      finalPayableAmountUsd: string;
      newStatus: string;
      chargesPayableAcctId: number;
      freightExpenseAcctId: number | null;
      ocExpenseAcctId: number | null;
    };

export async function computeOffloadCosting(ctx: OffloadCostingContext): Promise<OffloadCosting> {
  const {
    companyId,
    containerId,
    container,
    currencyCode,
    fxRate,
    offloadDate,
    declaredKg,
    dReceivedKg,
    baseCostPerKg,
    commission,
    freightVal,
    otherChargesVal,
    additionalChargesArr,
    dutyVal,
    dutyStatus,
    effectiveFreightSupplierId,
    reqFreightCurrencyCode,
    reqFreightFxRate,
    reqFreightAccountId,
    reqOtherChargesCurrencyCode,
    reqOtherChargesFxRate,
    reqOtherChargesSupplierId,
    reqOtherChargesAccountId,
  } = ctx;

  let commTotalVal = 0;
  let commCurrencyForUsd = currencyCode;
  let commFxRateForUsd = fxRate;
  let commInsertValues: typeof factoryContainerCommissions.$inferInsert | null = null;
  if (commission && commission.personName && commission.commissionRate) {
    const commType = commission.commissionType || "PER_KG";
    const commRate = parseFloat(commission.commissionRate) || 0;
    // Commission PER_KG is computed on the full declared weight — agreed for the
    // whole container, not just the portion received so far.
    commTotalVal = commType === "PER_KG" ? commRate * parseFloat(declaredKg) : commRate;
    const commCurrency = (commission.currencyCode || currencyCode).toUpperCase();
    commCurrencyForUsd = commCurrency;

    // Commission FX: resolve independently — may differ from both USD and container ccy.
    let resolvedCommFxRate: number;
    if (commCurrency === "USD") {
      resolvedCommFxRate = 1;
    } else if (commCurrency === currencyCode.toUpperCase()) {
      resolvedCommFxRate = fxRate;
    } else {
      try {
        resolvedCommFxRate = parseFloat(await getOrFetchFxRateToUsd(companyId, commCurrency, offloadDate));
      } catch (err: unknown) {
        return {
          ok: false,
          httpStatus: 400,
          body: {
            message: `Cannot resolve FX rate for commission currency ${commCurrency} on ${offloadDate}. ${getErrorMessage(err)}`,
          },
        };
      }
    }
    commFxRateForUsd = resolvedCommFxRate;
    const commTotalUsd = commCurrency === "USD" ? commTotalVal : commTotalVal * resolvedCommFxRate;
    commInsertValues = {
      companyId,
      containerId,
      personName: commission.personName,
      commissionType: commType,
      commissionRate: String(commRate),
      commissionTotal: String(commTotalVal),
      currencyCode: commCurrency,
      fxRateToUsd: String(resolvedCommFxRate),
      fxRateConfirmed: true,
      commissionTotalUsd: String(commTotalUsd),
      ledgerAccountId: commission.ledgerAccountId ? parseInt(commission.ledgerAccountId) : null,
    };
  }

  // Compute per-component USD values — kept for daybook/voucher posting.
  const freightCcy = reqFreightCurrencyCode || currencyCode;
  const freightFxRateVal = parseFloat(reqFreightFxRate || String(fxRate));
  const freightUsd = freightCcy === "USD" ? freightVal : freightVal * freightFxRateVal;

  const ocCcy = reqOtherChargesCurrencyCode || currencyCode;
  const ocFxRateVal = parseFloat(reqOtherChargesFxRate || String(fxRate));
  const ocUsd = ocCcy === "USD" ? otherChargesVal : otherChargesVal * ocFxRateVal;

  // ── Build container snapshot for the shared landed-cost helper ────────────
  // All financial fields (inclusive cost/kg, finalPayableAmount, USD totals) are
  // computed by the single authoritative helper to eliminate duplicate logic that
  // could drift from the recalc tool or rawStockContainerRoutes.
  const containerSnapshot = {
    ...container,
    currencyCode,
    ratePerKg: String(baseCostPerKg),
    totalKg: container.totalKg,
    declaredKg: String(declaredKg),
    actualReceivedKg: dReceivedKg.toDecimalPlaces(3).toFixed(3),
    // Container FX confirmed — was resolved above before any charges were processed.
    fxRateToUsd: String(fxRate),
    fxRateToUsdOffload: String(fxRate),
    fxRateConfirmed: true,
    // Freight FX confirmed (user-supplied rate, or container FX for same-ccy freight).
    freight: String(freightVal),
    freightCurrencyCode: freightCcy,
    freightFxRateToUsd: String(freightFxRateVal),
    freightFxRateConfirmed: true,
    // Duty (CONFIRMED includes the amount; PENDING/NONE → zero in the helper).
    dutyAmount: String(dutyVal),
    dutyStatus: dutyStatus as string,
    // OC and commission are passed as explicit row/record args to avoid double-counting.
    otherCharges: "0",
    commissionAmount: "0",
  };

  // The charge/commission arguments here are three- and four-field literals
  // holding just the amount, currency and FX state, passed against the helper's
  // structural `ChargeMoneyFields` parameter type (full $inferSelect rows also
  // satisfy it). The container itself is still a synthesised snapshot with
  // charge fields zeroed so they are not counted twice — hence the one
  // remaining `as unknown as` conversion on the first argument.
  //
  // OC as a single per-row entry so the helper uses the confirmed-FX code path.
  const ocRowsForHelper: {
    amount: string;
    currencyCode: string;
    fxRateToUsd: string;
    fxRateConfirmed: boolean;
  }[] =
    otherChargesVal > 0
      ? [
          {
            amount: String(otherChargesVal),
            currencyCode: ocCcy,
            fxRateToUsd: String(ocFxRateVal),
            fxRateConfirmed: true,
          },
        ]
      : [];

  // Additional charges: confirmed when an explicit rate was supplied for a
  // non-container-currency charge; same-ccy charges need no separate rate.
  const addlForHelper: { amount: string; currencyCode: string; fxRateToUsd: string; fxRateConfirmed: boolean }[] =
    additionalChargesArr.map((c) => ({
      amount: c.amount || "0",
      currencyCode: c.currencyCode || currencyCode,
      fxRateToUsd: c.fxRateToUsd || (c.currencyCode === "USD" ? "1" : String(fxRate)),
      fxRateConfirmed: !!(c.fxRateToUsd && parseFloat(c.fxRateToUsd) > 0),
    }));

  // Commission record: confirmed (rate was resolved above or is 1 for USD).
  const commissionForHelper: {
    commissionTotal: string;
    currencyCode: string | undefined;
    fxRateToUsd: string;
    fxRateConfirmed: boolean;
  } | null = commInsertValues
    ? {
        commissionTotal: String(commTotalVal),
        currencyCode: commInsertValues.currencyCode,
        fxRateToUsd: String(commFxRateForUsd),
        fxRateConfirmed: true,
      }
    : null;

  const helperResult = computeContainerLandedCost(
    containerSnapshot as unknown as Parameters<typeof computeContainerLandedCost>[0],
    addlForHelper,
    commissionForHelper,
    ocRowsForHelper
  );

  if (helperResult.fxUnresolved) {
    return {
      ok: false,
      httpStatus: 400,
      body: {
        message:
          "One or more charges have an unresolved exchange rate. " +
          "Provide explicit FX rates for all non-USD charges in a currency different from the container.",
      },
    };
  }

  const dInclusiveCostPerKg = new Decimal(helperResult.costPerKg);
  const dCostPerKgUsd = new Decimal(helperResult.costPerKgUsd);
  const finalPayableAmount = new Decimal(helperResult.fullCost).toDecimalPlaces(6).toFixed(6);
  const finalPayableAmountUsd = new Decimal(helperResult.fullCostUsd).toDecimalPlaces(6).toFixed(6);
  const newStatus = dReceivedKg.lt(new Decimal(declaredKg).minus(new Decimal("0.001")))
    ? "PARTIALLY_RECEIVED"
    : "OFFLOADED";

  // ── Pre-fetch ledger accounts BEFORE opening the transaction ──────────────
  // getOrCreateLedgerAccount uses the raw db connection and must not run inside
  // a transaction (it performs its own upsert). We resolve all IDs here so the
  // transaction body only uses tx.* calls and stays fully atomic.
  const chargesPayableAcctId = await getOrCreateLedgerAccount(
    companyId,
    "FACTORY_CHARGES_PAYABLE",
    "Factory Charges Payable"
  );
  const freightExpenseAcctId =
    freightVal > 0 && effectiveFreightSupplierId
      ? reqFreightAccountId
        ? parseInt(reqFreightAccountId)
        : await getOrCreateLedgerAccount(companyId, "FACTORY_FREIGHT_EXPENSE", "Freight Expense")
      : null;
  const ocExpenseAcctId =
    otherChargesVal > 0 && reqOtherChargesSupplierId
      ? reqOtherChargesAccountId
        ? parseInt(reqOtherChargesAccountId)
        : await getOrCreateLedgerAccount(companyId, "FACTORY_OC_EXPENSE", "Other Charges Expense")
      : null;

  return {
    ok: true,
    commTotalVal,
    commCurrencyForUsd,
    commFxRateForUsd,
    commInsertValues,
    freightCcy,
    freightFxRateVal,
    freightUsd,
    ocCcy,
    ocFxRateVal,
    ocUsd,
    dInclusiveCostPerKg,
    dCostPerKgUsd,
    finalPayableAmount,
    finalPayableAmountUsd,
    newStatus,
    chargesPayableAcctId,
    freightExpenseAcctId,
    ocExpenseAcctId,
  };
}
