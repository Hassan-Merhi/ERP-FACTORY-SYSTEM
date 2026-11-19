// Extracted from ./offloadCosting.ts
import Decimal from "decimal.js";
import { factoryContainerCommissions } from "@shared/schema";

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
  | { ok: false; httpStatus: number; body: { message: string; code?: string } }
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
