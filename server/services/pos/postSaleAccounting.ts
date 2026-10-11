/**
 * server/services/pos/postSaleAccounting.ts
 *
 * PHASE 19 structural split — moved (unchanged) from server/routes/pos/posSalesRoutes.ts:
 *   - Sales revenue account resolution
 *   - Supplier-partner accounting context precompute
 *   - Debit/credit voucher entries (normal ERP and supplier-partner split accounting)
 *
 * Phase 15 update: voucher entries now carry all 7 dual-currency fields via
 * normalizeVoucherEntryAmounts(). The backward-compatible debitAmount / creditAmount
 * columns always store the historical base (USD) value so legacy queries keep working.
 */
import { db } from "../../db";
import type { DbTransaction } from "../../db";
import { logger } from "../../lib/logger";
import { storage } from "../../storage";
import { ledgerAccounts } from "@shared/schema";
import { eq, and, isNull } from "drizzle-orm";
import type {
  HandlerErrorResult,
  PosLedgerAccount,
  PosLocation,
  SupplierPartnerAccountingContext,
  ValidatedInventoryItem,
} from "./posSaleTypes";
import { findLinkedCustomerId } from "./updateCustomerBalance";
import { MoneyDecimal, sumMoney, toMoney, type MoneyInput } from "../../lib/money";
import type { ErpVoucherLine } from "../accounting/erpVoucherPosting";
import { posSaleLines, type PosLineTarget } from "./saleAccountingLines";

/**
 * Get or create SALES revenue account (outside transaction for simplicity).
 * Use getOrCreateLedgerAccount so soft-deleted duplicates don't cause a
 * unique-constraint crash — it handles the 23505 error and falls back to
 * fetching the existing (possibly soft-deleted) row.
 */
export async function getOrCreateSalesRevenueAccount(
  companyId: number
): Promise<{ salesAccount: PosLedgerAccount } | { error: HandlerErrorResult }> {
  const salesAccount = await storage.getOrCreateLedgerAccount({
    companyId,
    code: "SALES",
    name: "Sales Revenue",
    accountType: "Income",
    openingBalance: "0",
    active: true,
  });

  if (salesAccount.accountType !== "Income") {
    // Validate that Sales account is of type Income for proper import cycle balance
    logger.warn(
      `[POS Sale] WARNING: SALES account has type "${salesAccount.accountType}" instead of "Income". This will cause import cycle imbalance!`
    );
    return {
      error: {
        status: 400,
        body: {
          message: `The SALES account is configured with type "${salesAccount.accountType}" but must be type "Income" for POS sales to work correctly. Please update the SALES account type in Accounts page.`,
        },
      },
    };
  }

  return { salesAccount };
}

/** ── SP company: fetch configured POS accounts & pre-compute supplier cost ── */
export async function fetchSupplierPartnerAccountingContext(
  isSpCompany: boolean,
  companyId: number,
  location: PosLocation,
  inventoryValidation: ValidatedInventoryItem[]
): Promise<SupplierPartnerAccountingContext | { error: HandlerErrorResult }> {
  // Per-qty deduction that silently reduces Supplier Cash Payable (not income/expense)
  const spPosDeductionPerQty = isSpCompany ? toMoney(location.supplierPartnerPayableDeductionPerQty).toNumber() : 0;
  const spPosTotalQtySold = isSpCompany ? sumMoney(inventoryValidation.map((v) => v.saleQty)).toNumber() : 0;

  if (!isSpCompany) {
    return {
      isSpCompany,
      spPosPayableAccountId: null,
      spPosProfitAccountId: null,
      spPosCostClrAccountId: null,
      spPosDeductionClrAccountId: null,
      totalSupplierCost: 0,
      spPosDeductionPerQty,
      spPosTotalQtySold,
    };
  }

  const spSettings = await storage.getCompanySettings(companyId);
  const spPosPayableAccountId = spSettings?.spPosPayableAccountId ?? null;
  const spPosProfitAccountId = spSettings?.spPosProfitAccountId ?? null;
  if (!spPosPayableAccountId || !spPosProfitAccountId) {
    return {
      error: {
        status: 400,
        body: { message: "Supplier POS payable/profit accounts are not configured. Go to SP Setup to set them up." },
      },
    };
  }

  // Look up Stock Cost Payable Clearing account (sp_cost_clearing subType)
  const [clrAcct] = await db
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.subType, "sp_cost_clearing"),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .limit(1);
  const spPosCostClrAccountId = clrAcct?.id ?? null;

  // Look up Supplier Payable Deduction Clearing account (sp_pay_deduction_clearing subType)
  const [ddcAcct] = await db
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.subType, "sp_pay_deduction_clearing"),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .limit(1);
  const spPosDeductionClrAccountId = ddcAcct?.id ?? null;

  // Pre-compute total supplier cost from inventory averageRate (includes landed/offloading cost)
  const totalSupplierCost = inventoryValidation
    .reduce((sum, v) => sum.plus(toMoney(v.saleQty).times(toMoney(v.currentRate))), new MoneyDecimal(0))
    .toNumber();

  return {
    isSpCompany,
    spPosPayableAccountId,
    spPosProfitAccountId,
    spPosCostClrAccountId,
    spPosDeductionClrAccountId,
    totalSupplierCost,
    spPosDeductionPerQty,
    spPosTotalQtySold,
  };
}

/**
 * Phase 22 (B): the lines of a POS sale voucher (Dr payment, Cr Sales Revenue
 * or the supplier-partner split), in exact cents. The caller posts them
 * through the central engine; this function used to insert the entries itself
 * with float amounts.
 *
 * The frontend converts item rates to USD before sending them, so the total is
 * USD even for a CFA sale; a CFA line also carries its CFA amount (total x
 * rate) at the voucher's rate.
 */
export async function buildSaleAccountingLines(
  tx: DbTransaction,
  params: {
    voucherLabel: string;
    grandTotal: MoneyInput;
    isCreditSale: boolean | null | undefined;
    accountType: "cash" | "bank" | "credit";
    accountId: number;
    location: PosLocation;
    customerAccount: PosLedgerAccount | null;
    companyId: number;
    isSpCompany: boolean;
    salesAccount: PosLedgerAccount;
    spCtx: SupplierPartnerAccountingContext;
    currency?: string | null;
    exchangeRate?: string | null;
  }
): Promise<ErpVoucherLine[]> {
  const { isCreditSale, accountType, accountId, location, customerAccount, companyId, spCtx, voucherLabel } = params;
  const narration = isCreditSale
    ? `Credit Invoice Sale at ${location.name} - ${customerAccount?.name ?? ""}`
    : `POS Sale - ${voucherLabel}`;

  const payment: PosLineTarget = {};
  if (isCreditSale || accountType === "cash" || accountType === "credit") {
    payment.ledgerAccountId = accountId;
    if (isCreditSale && accountType === "credit") {
      const linkedCustId = await findLinkedCustomerId(tx, companyId, accountId);
      if (linkedCustId !== undefined) payment.customerId = linkedCustId;
    }
  } else {
    payment.bankAccountId = accountId;
  }

  return posSaleLines({
    grandTotal: params.grandTotal,
    payment,
    paymentNarration: narration,
    revenue: params.isSpCompany ? null : { target: { ledgerAccountId: params.salesAccount.id }, narration },
    supplierPartner: params.isSpCompany
      ? {
          payableAccountId: spCtx.spPosPayableAccountId!,
          deductionClearingAccountId: spCtx.spPosDeductionClrAccountId,
          quantitySold: spCtx.spPosTotalQtySold,
          deductionPerQty: spCtx.spPosDeductionPerQty,
          payableNarration: `Supplier Cash Payable — ${voucherLabel}`,
          deductionNarration: `Supplier Payable Deduction (${spCtx.spPosTotalQtySold} qty × ${spCtx.spPosDeductionPerQty}) — ${voucherLabel}`,
        }
      : null,
    currency: params.currency,
    exchangeRate: params.exchangeRate,
  });
}
