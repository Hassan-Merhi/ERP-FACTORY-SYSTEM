import {
  infrastructurePostingIdentity,
  insertInfrastructureVoucherTx,
} from "../accounting/infrastructureVoucherIdentity";
/**
 * rentalPaymentPostingService.ts
 *
 * Single authoritative source for rental payment accounting.
 * Allocation selection lives in rentalPaymentAllocationService so this service
 * stays focused on posting and scheduling behavior.
 */

import { db, pool } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { isClosedPeriodError } from "../../lib/closedPeriodError";
import { writeAuditEvent } from "../audit";
import {
  propertyPayments,
  propertyMonthlyLedger,
  propertyContracts,
  propertyUnits,
  voucherEntries,
} from "@shared/schema";
import { eq, and, sql, inArray } from "drizzle-orm";
import Decimal from "decimal.js";
import { parseMoneyInput, sumMoney, toMoney } from "../../lib/money";
import type { RentalModule } from "../../routes/rental/shared";
import { normalizeVoucherEntryAmounts } from "../accounting/currencyAmounts";
import { findOrCreateLedgerAccount, maybeRunAutoTransfer } from "../../routes/rental/shared";
import { isRentalPeriodDue, getRentalBillingDay, getRentalPeriodDueDate } from "./rentalPeriodService";
import { buildAllocationsForPayment, findEarliestOutstandingMonth } from "./rentalPaymentAllocationService";
import { isRentalRateRequiredError, recordedRentalPaymentRate } from "./rentalPaymentRate";

export { buildAllocationsForPayment, findEarliestOutstandingMonth } from "./rentalPaymentAllocationService";

/** The rental contract fields this posting flow reads. */
export type RentalContractRef = {
  id: number;
  companyId: number;
  unitId: number;
  rentalAmount: string;
  startDate: string;
};

/** The rental unit fields this posting flow reads. */
export type RentalUnitRef = {
  unitNumber: string;
  unitType: string | null;
  locationGroup: string | null;
};

/** A posting failure that carries the HTTP status the route should return. */
type RentalPostingError = Error & { status?: number };

export {
  RENTAL_RATE_REQUIRED_CODE,
  RENTAL_RATE_REQUIRED_MESSAGE,
  isRentalRateRequiredError,
  recordedRentalPaymentRate,
} from "./rentalPaymentRate";

export interface RentalPaymentGroupOptions {
  companyId: number;
  contractCompanyId: number;
  module: RentalModule;
  contract: RentalContractRef;
  unit: RentalUnitRef | null;
  cashAccountId: number | null;
  amount: string;
  paymentDate: string;
  clientDate: string;
  scheduleFuturePayment?: boolean;
  currency: string;
  exchangeRate: string;
  notes: string | null;
  shopExpenseAccountName: string;
  incomeAccountName: string;
  isSharedPayment?: boolean;
  /** Phase 19 (B): the request's actor, audited with the posting. */
  audit?: { actor: { userId: string; username: string }; trigger: string };
}

/** Deterministic int64 advisory-lock key for a payment group ID. */
function hashGroupId(groupId: string): bigint {
  let h = 5381n;
  for (let i = 0; i < groupId.length; i++) {
    h = ((h << 5n) + h + BigInt(groupId.charCodeAt(i))) & 0xffffffffffffffffn;
  }
  if (h > 9223372036854775807n) h -= 18446744073709551616n;
  return h;
}

// ── Core accounting engine ────────────────────────────────────────────────────

/**
 * Creates and posts one payment group's accounting inside a provided
 * transaction. Shared by createRentalPaymentGroup and postScheduledGroup.
 * Returns the created voucherId (or null if no cashAccountId).
 */
async function postGroupCore(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  opts: {
    companyId: number;
    module: RentalModule;
    contract: RentalContractRef;
    unit: RentalUnitRef | null;
    cashAccountId: number | null;
    allocs: Array<{
      forYear: number;
      forMonth: number;
      chunk: string;
      ledgerRowId: number | null;
    }>;
    totalAmountStr: string;
    paymentDate: string;
    asOfDate: string;
    currency: string;
    /** ERP TRANSACTION_PER_BASE rate (foreign-per-USD). "1" for USD contracts. */
    exchangeRate: string;
    narration: string;
    shopExpenseAccountName: string;
    incomeAccountName: string;
    isSharedPayment?: boolean;
    groupId: string;
  }
): Promise<number | null> {
  const {
    companyId,
    module: mod,
    contract,
    unit,
    cashAccountId,
    allocs,
    totalAmountStr,
    paymentDate,
    asOfDate: _asOfDate,
    currency,
    exchangeRate,
    narration,
    shopExpenseAccountName,
    incomeAccountName,
    isSharedPayment,
    groupId,
  } = opts;

  /** Normalize an entry for this payment's currency and rate. */
  function normEntry(debit: string | number, credit: string | number) {
    const norm = normalizeVoucherEntryAmounts({
      transactionCurrency: currency,
      baseCurrency: "USD",
      transactionDebitAmount: String(debit),
      transactionCreditAmount: String(credit),
      historicalRate: exchangeRate,
    });
    return {
      transactionCurrency: norm.transactionCurrency,
      transactionDebitAmount: norm.transactionDebitAmount,
      transactionCreditAmount: norm.transactionCreditAmount,
      baseDebitAmount: norm.baseDebitAmount,
      baseCreditAmount: norm.baseCreditAmount,
      historicalExchangeRate: norm.historicalExchangeRate,
      rateConvention: norm.rateConvention,
      debitAmount: norm.debitAmount,
      creditAmount: norm.creditAmount,
    };
  }

  if (!cashAccountId) return null;

  const isShop = isSharedPayment || unit?.unitType === "SHOP";

  if (isShop) {
    const billingDay = contract ? getRentalBillingDay(contract.startDate as string) : 1;

    let accrualAmt = new Decimal(0);
    let advanceAmt = new Decimal(0);
    let prepaidAmt = new Decimal(0);

    const accrualLedgerIds: number[] = [];
    const advanceLedgerIds: number[] = [];
    const prepaidLedgerIds: number[] = [];

    for (const alloc of allocs) {
      const chunk = new Decimal(alloc.chunk);
      const due = isRentalPeriodDue(alloc.forYear, alloc.forMonth, billingDay, paymentDate);

      if (due) {
        let wasAccrued = false;
        if (alloc.ledgerRowId) {
          const [lr] = await tx
            .select({ accrualVoucherId: propertyMonthlyLedger.accrualVoucherId })
            .from(propertyMonthlyLedger)
            .where(eq(propertyMonthlyLedger.id, alloc.ledgerRowId));
          wasAccrued = !!lr?.accrualVoucherId;
        }
        if (wasAccrued) {
          accrualAmt = accrualAmt.plus(chunk);
          if (alloc.ledgerRowId) accrualLedgerIds.push(alloc.ledgerRowId);
        } else {
          advanceAmt = advanceAmt.plus(chunk);
          if (alloc.ledgerRowId) advanceLedgerIds.push(alloc.ledgerRowId);
        }
      } else {
        prepaidAmt = prepaidAmt.plus(chunk);
        if (alloc.ledgerRowId) prepaidLedgerIds.push(alloc.ledgerRowId);
      }
    }

    const sumCheck = accrualAmt.plus(advanceAmt).plus(prepaidAmt);
    if (sumCheck.lt(0.005) && new Decimal(totalAmountStr).gt(0.005)) {
      advanceAmt = new Decimal(totalAmountStr);
      for (const alloc of allocs) {
        if (alloc.ledgerRowId) advanceLedgerIds.push(alloc.ledgerRowId);
      }
    }

    const voucherNum = `RENT-${paymentDate.replace(/-/g, "")}-${groupId.slice(-6)}`;
    const { voucher: v } = await insertInfrastructureVoucherTx(
      tx,
      {
        companyId,
        voucherNumber: voucherNum,
        voucherType: "Payment",
        voucherDate: paymentDate,
        description: narration,
        totalAmount: totalAmountStr,
        currency,
        sourceModule: "ERP",
      },
      infrastructurePostingIdentity("rental-payment", String(companyId) + ":" + String(groupId), "payment"),
      { allocs, totalAmountStr, cashAccountId, currency, exchangeRate }
    );

    const payEntries = [
      { voucherId: v.id, ledgerAccountId: cashAccountId, ...normEntry("0", totalAmountStr), narration },
    ];

    if (accrualAmt.gt(0.005)) {
      const accPayId = await findOrCreateLedgerAccount(
        tx,
        companyId,
        "Accrued Rent Payable",
        "Liability",
        "ACC-RENT-PAY"
      );
      payEntries.push({
        voucherId: v.id,
        ledgerAccountId: accPayId,
        ...normEntry(accrualAmt.toFixed(2), "0"),
        narration,
      });
    }

    if (advanceAmt.gt(0.005)) {
      const advId = await findOrCreateLedgerAccount(tx, companyId, "Advance Rent Paid", "Asset", "ADV-RENT-PAID");
      payEntries.push({
        voucherId: v.id,
        ledgerAccountId: advId,
        ...normEntry(advanceAmt.toFixed(2), "0"),
        narration,
      });
    }

    if (prepaidAmt.gt(0.005)) {
      const prepId = await findOrCreateLedgerAccount(tx, companyId, "Prepaid Rent", "Asset", "PREPAID-RENT");
      payEntries.push({
        voucherId: v.id,
        ledgerAccountId: prepId,
        ...normEntry(prepaidAmt.toFixed(2), "0"),
        narration,
      });
    }

    await tx.insert(voucherEntries).values(payEntries);

    let recognitionVoucherId: number | null = null;
    if (advanceAmt.gt(0.005)) {
      const recNarr = `Advance rent recognition - ${narration}`;
      const { voucher: rv } = await insertInfrastructureVoucherTx(
        tx,
        {
          companyId,
          voucherNumber: `ADV-REC-${paymentDate.replace(/-/g, "")}-${groupId.slice(-6)}`,
          voucherType: "Journal",
          voucherDate: paymentDate,
          description: recNarr,
          totalAmount: advanceAmt.toFixed(2),
          currency,
          sourceModule: "ERP",
        },
        infrastructurePostingIdentity(
          "rental-payment",
          String(companyId) + ":" + String(groupId),
          "advance-recognition"
        ),
        { allocs, totalAmountStr, cashAccountId, currency, exchangeRate }
      );
      recognitionVoucherId = rv.id;

      const expId = await findOrCreateLedgerAccount(
        tx,
        companyId,
        shopExpenseAccountName,
        "Indirect Expense",
        "SHOP-RENT-EXP"
      );
      const advId = await findOrCreateLedgerAccount(tx, companyId, "Advance Rent Paid", "Asset", "ADV-RENT-PAID");
      await tx.insert(voucherEntries).values([
        {
          voucherId: rv.id,
          ledgerAccountId: expId,
          ...normEntry(advanceAmt.toFixed(2), "0"),
          narration: recNarr,
        },
        {
          voucherId: rv.id,
          ledgerAccountId: advId,
          ...normEntry("0", advanceAmt.toFixed(2)),
          narration: recNarr,
        },
      ]);
    }

    if (advanceLedgerIds.length > 0) {
      await tx
        .update(propertyMonthlyLedger)
        .set({
          usedAdvanceAccount: true,
          usedPrepaidAccount: false,
          accrualVoucherId: recognitionVoucherId,
        })
        .where(inArray(propertyMonthlyLedger.id, advanceLedgerIds));
    }
    if (prepaidLedgerIds.length > 0) {
      await tx
        .update(propertyMonthlyLedger)
        .set({ usedPrepaidAccount: true, usedAdvanceAccount: false })
        .where(inArray(propertyMonthlyLedger.id, prepaidLedgerIds));
    }
    if (accrualLedgerIds.length > 0) {
      await tx
        .update(propertyMonthlyLedger)
        .set({ usedPrepaidAccount: false, usedAdvanceAccount: false })
        .where(inArray(propertyMonthlyLedger.id, accrualLedgerIds));
    }

    return v.id;
  } else {
    const incomeAccountId = await findOrCreateLedgerAccount(
      tx,
      companyId,
      incomeAccountName,
      "Income",
      "RENT-INC",
      "Indirect Income"
    );

    if (mod === "PROPERTIES") {
      const voucherNum = `RENT-${paymentDate.replace(/-/g, "")}-${groupId.slice(-6)}`;
      const { voucher: v } = await insertInfrastructureVoucherTx(
        tx,
        {
          companyId,
          voucherNumber: voucherNum,
          voucherType: "Receipt",
          voucherDate: paymentDate,
          description: narration,
          totalAmount: totalAmountStr,
          currency,
          sourceModule: "ERP",
        },
        infrastructurePostingIdentity("rental-payment", String(companyId) + ":" + String(groupId), "payment"),
        { allocs, totalAmountStr, cashAccountId, currency, exchangeRate }
      );

      await tx.insert(voucherEntries).values([
        {
          voucherId: v.id,
          ledgerAccountId: cashAccountId,
          ...normEntry(totalAmountStr, "0"),
          narration,
        },
        {
          voucherId: v.id,
          ledgerAccountId: incomeAccountId,
          ...normEntry("0", totalAmountStr),
          narration,
        },
      ]);

      const landlordLedgerIds = allocs.map((a) => a.ledgerRowId).filter(Boolean) as number[];
      if (landlordLedgerIds.length > 0) {
        await tx
          .update(propertyMonthlyLedger)
          .set({ usedPrepaidAccount: false, usedAdvanceAccount: false })
          .where(inArray(propertyMonthlyLedger.id, landlordLedgerIds));
      }

      return v.id;
    }

    const pd = new Date(paymentDate + "T00:00:00Z");
    const payYear = pd.getUTCFullYear();
    const payMonth = pd.getUTCMonth() + 1;
    const futureAllocs = allocs.filter((a) => a.forYear > payYear || (a.forYear === payYear && a.forMonth > payMonth));
    // Exact: the earned and deferred credits add up to the cash debit to the cent.
    const deferredChunk = sumMoney(futureAllocs.map((a) => a.chunk));
    const earnedChunk = toMoney(totalAmountStr).minus(deferredChunk);

    const voucherNum = `RENT-${paymentDate.replace(/-/g, "")}-${groupId.slice(-6)}`;
    const { voucher: v } = await insertInfrastructureVoucherTx(
      tx,
      {
        companyId,
        voucherNumber: voucherNum,
        voucherType: "Receipt",
        voucherDate: paymentDate,
        description: narration,
        totalAmount: totalAmountStr,
        currency,
        sourceModule: "ERP",
      },
      infrastructurePostingIdentity("rental-payment", String(companyId) + ":" + String(groupId), "payment"),
      { allocs, totalAmountStr, cashAccountId, currency, exchangeRate }
    );

    const lEntries = [
      {
        voucherId: v.id,
        ledgerAccountId: cashAccountId,
        ...normEntry(totalAmountStr, "0"),
        narration,
      },
    ];
    if (earnedChunk.gt("0.005")) {
      lEntries.push({
        voucherId: v.id,
        ledgerAccountId: incomeAccountId,
        ...normEntry("0", earnedChunk.toFixed(2)),
        narration,
      });
    }
    if (deferredChunk.gt("0.005")) {
      const deferredId = await findOrCreateLedgerAccount(
        tx,
        companyId,
        "Deferred Rent Revenue",
        "Liability",
        "DEF-RENT-REV"
      );
      lEntries.push({
        voucherId: v.id,
        ledgerAccountId: deferredId,
        ...normEntry("0", deferredChunk.toFixed(2)),
        narration,
      });
      const futureIds = futureAllocs.map((a) => a.ledgerRowId).filter(Boolean) as number[];
      if (futureIds.length > 0) {
        await tx
          .update(propertyMonthlyLedger)
          .set({ usedPrepaidAccount: true })
          .where(inArray(propertyMonthlyLedger.id, futureIds));
      }
    }
    await tx.insert(voucherEntries).values(lEntries);

    return v.id;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function createRentalPaymentGroup(opts: RentalPaymentGroupOptions) {
  const {
    companyId,
    contractCompanyId,
    module: mod,
    contract,
    unit,
    cashAccountId,
    amount,
    paymentDate,
    clientDate,
    scheduleFuturePayment,
    currency,
    exchangeRate,
    notes,
    shopExpenseAccountName,
    incomeAccountName,
    isSharedPayment,
  } = opts;

  if (paymentDate > clientDate && !scheduleFuturePayment) {
    const err: RentalPostingError = new Error("Future payment dates require Schedule future payment.");
    err.status = 400;
    throw err;
  }
  // Phase 19 (B), PE2: the recorded dated rate, never the client's (it was
  // defaulted to "1"); `exchangeRate` from the request is not used.
  void exchangeRate;
  const recordedRate = await recordedRentalPaymentRate(companyId, currency || "USD", paymentDate);

  const billingDay = getRentalBillingDay(contract.startDate as string);
  // A non-numeric amount allocates nothing (the caller refuses an empty allocation).
  const totalAmountExact = parseMoneyInput(amount) ?? 0;

  const { year: startY, month: startM } = await findEarliestOutstandingMonth(contract.id, billingDay, paymentDate);

  const allocations = await buildAllocationsForPayment(
    contract.id,
    startY,
    startM,
    totalAmountExact,
    contract.rentalAmount as string,
    billingDay,
    paymentDate
  );

  const paymentGroupId = `PG-${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${contract.id}`;

  const scheduledRows = await db.transaction(async (tx) => {
    for (const alloc of allocations) {
      const allocDueDate = getRentalPeriodDueDate(alloc.year, alloc.month, billingDay);
      const allocIsDue = allocDueDate <= paymentDate;
      const expectedForAlloc = allocIsDue ? contract.rentalAmount : "0";
      await tx.execute(sql`
        INSERT INTO property_monthly_ledger (
          company_id, module, contract_id, unit_id, year, month, expected_amount, paid_amount
        ) VALUES (
          ${contractCompanyId}, ${mod}, ${contract.id}, ${contract.unitId},
          ${alloc.year}, ${alloc.month}, ${expectedForAlloc}, 0
        )
        ON CONFLICT (contract_id, year, month)
        DO UPDATE SET
          expected_amount = CASE
            WHEN property_monthly_ledger.expected_amount::numeric = 0
            THEN EXCLUDED.expected_amount
            ELSE property_monthly_ledger.expected_amount
          END
      `);
    }

    const created: (typeof propertyPayments.$inferSelect)[] = [];
    for (const alloc of allocations) {
      const [lr] = await tx
        .select({ id: propertyMonthlyLedger.id })
        .from(propertyMonthlyLedger)
        .where(
          and(
            eq(propertyMonthlyLedger.contractId, contract.id),
            eq(propertyMonthlyLedger.year, alloc.year),
            eq(propertyMonthlyLedger.month, alloc.month)
          )
        );

      const [p] = await tx
        .insert(propertyPayments)
        .values({
          companyId: companyId,
          module: mod,
          contractId: contract.id,
          unitId: contract.unitId,
          ledgerRowId: lr?.id ?? null,
          cashAccountId: cashAccountId ?? null,
          voucherId: null,
          amount: alloc.chunk,
          paymentDate: paymentDate,
          forYear: alloc.year,
          forMonth: alloc.month,
          currency: currency || "USD",
          exchangeRate: recordedRate,
          notes: allocations.length > 1 ? `${notes ? notes + " | " : ""}Split from ${amount} payment` : (notes ?? null),
          postingStatus: "SCHEDULED",
          paymentGroupId,
        })
        .returning();
      created.push(p);
    }
    return created;
  });

  if (paymentDate <= clientDate) {
    await postScheduledGroup(
      companyId,
      contractCompanyId,
      mod,
      contract,
      unit,
      paymentGroupId,
      paymentDate,
      clientDate,
      cashAccountId,
      currency,
      recordedRate,
      notes,
      shopExpenseAccountName,
      incomeAccountName,
      isSharedPayment ?? false,
      opts.audit
    );

    const posted = await db
      .select()
      .from(propertyPayments)
      .where(
        and(eq(propertyPayments.paymentGroupId, paymentGroupId), sql`${propertyPayments.postingStatus} = 'POSTED'`)
      );

    return { paymentGroupId, scheduled: false, payments: posted };
  }

  return { paymentGroupId, scheduled: true, payments: scheduledRows };
}

/** Who posts due scheduled payments, and the company's closed-books date (wave 18 A). */
export interface DueScheduledPaymentOptions {
  /** Groups dated on or before this date are skipped (PERIOD_CLOSED), never forced. */
  closedThrough?: string | null;
  actor?: { userId: string; username: string };
  trigger?: "scheduler" | "manual" | "route";
}

export interface DueScheduledPaymentResult {
  posted: number;
  skipped: Array<{
    paymentGroupId: string;
    paymentDate: string;
    reason: "PERIOD_CLOSED";
    closedThrough: string | null;
  }>;
  failed: number;
}

export async function postDueScheduledRentalPayments(
  companyId: number,
  module: RentalModule,
  asOfDate: string,
  shopExpenseAccountName: string = "Rent Expense - Shops",
  incomeAccountName: string = "Rental Income"
): Promise<number> {
  const result = await postDueScheduledRentalPaymentsDetailed(
    companyId,
    module,
    asOfDate,
    shopExpenseAccountName,
    incomeAccountName,
    { trigger: "route" }
  );
  return result.posted;
}

/**
 * Posts every SCHEDULED payment group of the company/module dated on or before
 * asOfDate. A group dated in a closed period is skipped and reported; a
 * closed-period rejection from the database guard is reported the same way.
 * Each posted group has an audit row in its posting transaction.
 */
export async function postDueScheduledRentalPaymentsDetailed(
  companyId: number,
  module: RentalModule,
  asOfDate: string,
  shopExpenseAccountName: string,
  incomeAccountName: string,
  options: DueScheduledPaymentOptions
): Promise<DueScheduledPaymentResult> {
  const { rows } = await pool.query<{
    payment_group_id: string;
    payment_date: string;
    cash_account_id: number | null;
    currency: string;
    exchange_rate: string | null;
  }>(
    // payment_date as text: node-postgres returns a DATE as a JS Date, which the
    // posting code (voucher numbers, closed-period check) cannot use (wave 18 A).
    `SELECT DISTINCT payment_group_id, payment_date::text AS payment_date, cash_account_id,
            COALESCE(currency, 'USD') AS currency,
            exchange_rate::text AS exchange_rate
     FROM property_payments
     WHERE company_id = $1
       AND module = $2
       AND posting_status = 'SCHEDULED'
       AND payment_group_id IS NOT NULL
       AND payment_date <= $3
     ORDER BY payment_date`,
    [companyId, module, asOfDate]
  );

  let posted = 0;
  let failed = 0;
  const skipped: DueScheduledPaymentResult["skipped"] = [];
  const closedThrough = options.closedThrough ?? null;
  for (const row of rows) {
    const paymentDate = String(row.payment_date).slice(0, 10);
    if (closedThrough !== null && paymentDate <= closedThrough) {
      skipped.push({ paymentGroupId: row.payment_group_id, paymentDate, reason: "PERIOD_CLOSED", closedThrough });
      continue;
    }
    try {
      const groupRows = await db
        .select()
        .from(propertyPayments)
        .where(eq(propertyPayments.paymentGroupId, row.payment_group_id));

      if (groupRows.length === 0) continue;
      const firstRow = groupRows[0];

      const [contract] = await db.select().from(propertyContracts).where(eq(propertyContracts.id, firstRow.contractId));

      const [unit] = contract
        ? await db.select().from(propertyUnits).where(eq(propertyUnits.id, contract.unitId))
        : [null];

      const isShared = !!contract?.linkedCompanyId;

      const didPost = await postScheduledGroup(
        companyId,
        contract.companyId,
        module,
        contract,
        unit,
        row.payment_group_id,
        row.payment_date,
        asOfDate,
        row.cash_account_id,
        row.currency,
        // Phase 19 (B), PE2: the recorded rate on or before the payment date
        // (the stored row rate was the client's, defaulted to "1").
        await recordedRentalPaymentRate(companyId, row.currency, paymentDate),
        firstRow.notes as string | null,
        shopExpenseAccountName,
        incomeAccountName,
        isShared,
        { actor: options.actor ?? SCHEDULED_PAYMENT_ACTOR, trigger: options.trigger ?? "route" }
      );
      if (didPost) posted++;
    } catch (err: unknown) {
      if (isClosedPeriodError(err)) {
        skipped.push({ paymentGroupId: row.payment_group_id, paymentDate, reason: "PERIOD_CLOSED", closedThrough });
        continue;
      }
      if (isRentalRateRequiredError(err)) {
        failed++;
        logger.warn(`[rentalPostingService] Group ${row.payment_group_id} not posted: no recorded rate`, {
          currency: err.currency,
          paymentDate,
        });
        continue;
      }
      failed++;
      logger.error(`[rentalPostingService] Failed to post group ${row.payment_group_id}:`, {
        error: getErrorMessage(err).split("\n")[0],
      });
    }
  }
  return { posted, skipped, failed };
}

const SCHEDULED_PAYMENT_ACTOR = { userId: "system", username: "rental-scheduled-payments" } as const;

async function postScheduledGroup(
  companyId: number,
  contractCompanyId: number,
  module: RentalModule,
  contract: RentalContractRef,
  unit: RentalUnitRef | null,
  groupId: string,
  paymentDate: string,
  asOfDate: string,
  cashAccountId: number | null,
  currency: string,
  exchangeRate: string,
  notes: string | null,
  shopExpenseAccountName: string,
  incomeAccountName: string,
  isSharedPayment: boolean,
  audit?: { actor: { userId: string; username: string }; trigger: string }
): Promise<boolean> {
  const lockKey = hashGroupId(groupId);
  let groupRows: (typeof propertyPayments.$inferSelect)[] = [];

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey})`);

    groupRows = await tx
      .select()
      .from(propertyPayments)
      .where(and(eq(propertyPayments.paymentGroupId, groupId), sql`${propertyPayments.postingStatus} = 'SCHEDULED'`));

    if (groupRows.length === 0) return;

    const totalAmountStr = sumMoney(groupRows.map((r) => r.amount as string)).toFixed(2);

    const allocs = groupRows.map((r) => ({
      forYear: r.forYear,
      forMonth: r.forMonth,
      chunk: r.amount as string,
      ledgerRowId: r.ledgerRowId,
    }));

    const unitLabel = unit ? `${unit.locationGroup}/${unit.unitNumber}` : `Unit#${groupRows[0].unitId}`;
    const monthSpan =
      allocs.length > 1
        ? `${String(allocs[0].forMonth).padStart(2, "0")}/${allocs[0].forYear}–${String(allocs[allocs.length - 1].forMonth).padStart(2, "0")}/${allocs[allocs.length - 1].forYear}`
        : `${String(allocs[0].forMonth).padStart(2, "0")}/${allocs[0].forYear}`;
    const narration = `Rent paid - ${unitLabel} - ${monthSpan}`;

    // Phase 19 (B), PE2: the caller resolved the recorded dated rate.
    const groupExchangeRate = exchangeRate;

    const voucherId = await postGroupCore(tx, {
      companyId,
      module,
      contract,
      unit,
      cashAccountId,
      allocs,
      totalAmountStr,
      paymentDate,
      asOfDate,
      currency: currency || "USD",
      exchangeRate: groupExchangeRate,
      narration,
      shopExpenseAccountName,
      incomeAccountName,
      isSharedPayment,
      groupId,
    });

    for (const alloc of allocs) {
      if (alloc.ledgerRowId) {
        await tx.execute(sql`
          UPDATE property_monthly_ledger
          SET paid_amount = paid_amount + ${alloc.chunk}::numeric
          WHERE id = ${alloc.ledgerRowId}
        `);
      }
    }

    const rowIds = groupRows.map((r) => r.id);
    await tx
      .update(propertyPayments)
      .set({
        postingStatus: "POSTED",
        postedAt: new Date(),
        voucherId: voucherId ?? null,
        exchangeRate: groupExchangeRate,
      })
      .where(inArray(propertyPayments.id, rowIds));

    if (audit) {
      await writeAuditEvent(
        {
          userId: audit.actor.userId,
          username: audit.actor.username,
          companyId,
          action: "update",
          tableName: "property_payments",
          recordId: voucherId ?? null,
          recordIdentifier: `rental-scheduled-payment:${groupId}`,
          changes: {
            payments: {
              old: groupRows.map((r) => ({ id: r.id, postingStatus: "SCHEDULED", voucherId: r.voucherId ?? null })),
              new: groupRows.map((r) => ({ id: r.id, postingStatus: "POSTED", voucherId: voucherId ?? null })),
            },
            paymentDate: { new: paymentDate },
            totalAmount: { new: totalAmountStr },
            trigger: { new: audit.trigger },
          },
        },
        tx
      );
    }
  });

  if (groupRows.length === 0) return false;

  try {
    const firstRow = groupRows[0];
    if (firstRow.cashAccountId && unit) {
      const unitLabel = `${unit.locationGroup}/${unit.unitNumber}`;
      await maybeRunAutoTransfer(
        companyId,
        module,
        firstRow.cashAccountId,
        sumMoney(groupRows.map((r) => r.amount as string)).toFixed(2),
        paymentDate,
        unitLabel,
        firstRow.id,
        notes ?? undefined
      );
    }
  } catch (e: unknown) {
    logger.warn("[rentalPostingService] auto-transfer failed:", {
      error: getErrorMessage(e).split("\n")[0],
    });
  }

  return true;
}
