import type { Express, Request, Response } from "express";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { accountingPostingRequests, bankAccounts, ledgerAccounts, voucherEntries, vouchers } from "@shared/schema";
import { requireAuth, requireNonPOS } from "../../auth";
import { db } from "../../db";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { resultRows } from "../../lib/queryResult";
import {
  privilegedMutationRateLimit,
  privilegedReadRateLimit,
  privilegedRequestBudget,
} from "../../middleware/privilegedEndpointSecurity";
import {
  PostingValidationError,
  postBalancedVoucherTx,
  type PostingActor,
} from "../../services/accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../../services/accounting/databasePostingDependencies";
import {
  getGoldenCoastAccountDefinition,
  type GoldenCoastAccountRole,
} from "../../services/accounting/goldenCoastPhase2Accounts";
import {
  GOLDEN_COAST_PHASE10_SOURCE_TYPE,
  GoldenCoastPhase10SettlementError,
  buildGoldenCoastPhase10SettlementPosting,
  goldenCoastPhase10IdempotencyKey,
  goldenCoastPhase10SettlementDigest,
  goldenCoastPhase10SourceId,
  parseGoldenCoastPhase10SettlementInput,
  planGoldenCoastPhase10Settlement,
  type GoldenCoastPhase10CashAccount,
  type GoldenCoastPhase10SettlementInput,
} from "../../services/accounting/goldenCoastPhase10SalesCashSettlement";
import {
  gcSalesCashPayableBalance,
  gcSalesCashSettleablePayable,
} from "../../services/accounting/goldenCoastSalesCashPayable";
import {
  goldenCoastPhase3VoucherNumber,
  isGoldenCoastCompany,
  type DbLike,
} from "./spGoldenCoastPhase4CutoverFifoRoutes";
import { requireSpCompany } from "./spHelpers";

const postingDependencies = createDatabasePostingDependencies();
const phase10RequestBudget = privilegedRequestBudget({
  maxBodyBytes: 16 * 1024,
  maxCollectionItems: 10,
});
const PHASE10_ROLE = "gc_sales_cash" as const satisfies GoldenCoastAccountRole;

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

class GoldenCoastPhase10RouteError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = "GC_PHASE10_SETTLEMENT_INVALID", status = 400) {
    super(releaseDebtEnglish(message));
    this.name = "GoldenCoastPhase10RouteError";
    this.code = code;
    this.status = status;
  }
}

function actorFromRequest(req: Request): PostingActor {
  const reference = typeof req.body?.reference === "string" ? req.body.reference.trim() : "";
  return {
    userId: req.user?.id ?? req.session.userId ?? null,
    username: req.session.username ?? null,
    reason: reference || "Golden Coast Phase 10 Fresh Start payment",
  };
}

async function assertPhase10CutoverPosted(conn: DbLike, companyId: number): Promise<void> {
  const result = await conn.execute(sql`
    SELECT id
    FROM vouchers
    WHERE company_id = ${companyId}
      AND voucher_number = ${goldenCoastPhase3VoucherNumber(companyId)}
      AND deleted_at IS NULL
    LIMIT 1
  `);
  if (!resultRows(result)[0]) {
    throw new GoldenCoastPhase10RouteError(
      "Golden Coast Phase 3 cutover must be posted before Phase 10 Fresh Start payment",
      "GC_PHASE10_NOT_READY",
      409
    );
  }
}

async function resolveGcSalesCashAccount(
  conn: DbLike,
  companyId: number
): Promise<{ id: number; name: string; accountType: string }> {
  const definition = getGoldenCoastAccountDefinition(PHASE10_ROLE);
  const rows = await conn
    .select({
      id: ledgerAccounts.id,
      name: ledgerAccounts.name,
      accountType: ledgerAccounts.accountType,
    })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.subType, definition.subType),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .orderBy(asc(ledgerAccounts.id))
    .limit(2);

  if (rows.length !== 1) {
    throw new GoldenCoastPhase10RouteError(
      rows.length === 0
        ? "GC Sales Cash is not configured; run Golden Coast account setup first"
        : "GC Sales Cash is ambiguous; repair duplicate canonical accounts before paying Fresh Start",
      "GC_PHASE10_ACCOUNT_INVALID",
      409
    );
  }
  const account = {
    id: Number(rows[0].id),
    name: String(rows[0].name),
    accountType: String(rows[0].accountType),
  };
  if (!definition.acceptedAccountTypes.includes(account.accountType)) {
    throw new GoldenCoastPhase10RouteError(
      `GC Sales Cash must use account type ${definition.acceptedAccountTypes.join(" or ")}, not ${account.accountType}`,
      "GC_PHASE10_ACCOUNT_INVALID",
      409
    );
  }
  return account;
}

const SHARED_CHARGES_SUBTYPE = "sp_shared_charges";

/**
 * Resolves the Shared Charges expense account a transfer fee is booked to. It
 * is only required when a settlement actually carries a fee, so callers pass
 * `required: false` for readiness reporting.
 */
async function resolveSharedChargesAccount(
  conn: DbLike,
  companyId: number,
  required: boolean
): Promise<{ id: number; name: string } | null> {
  const rows = await conn
    .select({ id: ledgerAccounts.id, name: ledgerAccounts.name, accountType: ledgerAccounts.accountType })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.subType, SHARED_CHARGES_SUBTYPE),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .orderBy(asc(ledgerAccounts.id))
    .limit(2);

  if (rows.length !== 1) {
    if (!required) return null;
    throw new GoldenCoastPhase10RouteError(
      rows.length === 0
        ? "Shared Charges is not configured; a transfer fee cannot be booked"
        : "Shared Charges is ambiguous; repair duplicate accounts before charging a transfer fee",
      "GC_PHASE10_ACCOUNT_INVALID",
      409
    );
  }
  const account = { id: Number(rows[0].id), name: String(rows[0].name) };
  const accountType = String(rows[0].accountType);
  if (!["Direct Expense", "Expense"].includes(accountType)) {
    if (!required) return null;
    throw new GoldenCoastPhase10RouteError(
      `Shared Charges must be an expense account, not ${accountType}`,
      "GC_PHASE10_ACCOUNT_INVALID",
      409
    );
  }
  return account;
}

async function validatePaymentAccount(
  conn: DbLike,
  companyId: number,
  account: GoldenCoastPhase10CashAccount
): Promise<void> {
  if (account.kind === "bank") {
    const [row] = await conn
      .select({ id: bankAccounts.id })
      .from(bankAccounts)
      .where(
        and(
          eq(bankAccounts.id, account.id),
          eq(bankAccounts.companyId, companyId),
          eq(bankAccounts.active, true),
          isNull(bankAccounts.deletedAt)
        )
      )
      .limit(1);
    if (!row) {
      throw new GoldenCoastPhase10RouteError(
        "paymentAccount must reference an active bank account in the selected Golden Coast company",
        "GC_PHASE10_PAYMENT_ACCOUNT_INVALID",
        400
      );
    }
    return;
  }

  const [row] = await conn
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.id, account.id),
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt),
        inArray(ledgerAccounts.accountType, ["Cash", "Bank"])
      )
    )
    .limit(1);
  if (!row) {
    throw new GoldenCoastPhase10RouteError(
      "paymentAccount must reference an active Cash/Bank ledger account in the selected Golden Coast company",
      "GC_PHASE10_PAYMENT_ACCOUNT_INVALID",
      400
    );
  }
}

async function listPaymentAccounts(conn: DbLike, companyId: number) {
  const [ledgerRows, bankRows] = await Promise.all([
    conn
      .select({
        id: ledgerAccounts.id,
        name: ledgerAccounts.name,
        accountType: ledgerAccounts.accountType,
      })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.companyId, companyId),
          eq(ledgerAccounts.active, true),
          isNull(ledgerAccounts.deletedAt),
          inArray(ledgerAccounts.accountType, ["Cash", "Bank"])
        )
      )
      .orderBy(asc(ledgerAccounts.name)),
    conn
      .select({ id: bankAccounts.id, name: bankAccounts.name })
      .from(bankAccounts)
      .where(and(eq(bankAccounts.companyId, companyId), eq(bankAccounts.active, true), isNull(bankAccounts.deletedAt)))
      .orderBy(asc(bankAccounts.name)),
  ]);
  return [
    ...ledgerRows.map((row) => ({
      kind: "ledger" as const,
      id: Number(row.id),
      name: row.name,
      type: row.accountType,
    })),
    ...bankRows.map((row) => ({
      kind: "bank" as const,
      id: Number(row.id),
      name: row.name,
      type: "Bank Account",
    })),
  ];
}

/**
 * Signed Dr-minus-Cr balance; negative means GC Sales Cash is payable. Callers
 * convert it through `gcSalesCashPayableBalance` before reasoning about what is
 * still owed.
 */
async function gcSalesCashDebitBalance(
  conn: DbLike,
  companyId: number,
  accountId: number,
  cutoffDate?: string
): Promise<string> {
  const query = await conn.execute(sql`
    SELECT (
      CASE
        WHEN la.opening_balance_side = 'Cr' THEN -COALESCE(la.opening_balance, 0)::numeric
        ELSE COALESCE(la.opening_balance, 0)::numeric
      END
      + COALESCE((
        SELECT SUM(CAST(ve.debit_amount AS numeric) - CAST(ve.credit_amount AS numeric))
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id
        WHERE ve.ledger_account_id = ${accountId}
          AND v.company_id = ${companyId}
          AND v.deleted_at IS NULL
          AND COALESCE(v.optional, false) = false
          AND (
            ${cutoffDate ?? null}::date IS NULL
            OR COALESCE(v.effective_date, v.voucher_date) <= ${cutoffDate ?? null}::date
          )
      ), 0)
    )::text AS debit_minus_credit
    FROM ledger_accounts la
    WHERE la.id = ${accountId}
      AND la.company_id = ${companyId}
      AND la.active = true
      AND la.deleted_at IS NULL
    LIMIT 1
  `);
  const row = resultRows(query)[0];
  if (!row) {
    throw new GoldenCoastPhase10RouteError(
      "GC Sales Cash disappeared while its balance was being read",
      "GC_PHASE10_ACCOUNT_INVALID",
      409
    );
  }
  return String(row.debit_minus_credit ?? "0");
}

function amountEquals(left: unknown, right: string): boolean {
  try {
    return new Decimal(String(left ?? "0")).equals(new Decimal(right));
  } catch {
    return false;
  }
}

async function loadVoucherEntries(tx: DatabaseTransaction, voucherId: number) {
  return tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, voucherId));
}

async function findReplayedSettlement(
  tx: DatabaseTransaction,
  companyId: number,
  settlement: GoldenCoastPhase10SettlementInput,
  gcSalesCashAccountId: number,
  settlementDigest: string
) {
  const idempotencyKey = goldenCoastPhase10IdempotencyKey(companyId, settlement.clientRequestId);
  const [marker] = await tx
    .select({
      voucherId: accountingPostingRequests.voucherId,
      sourceId: accountingPostingRequests.sourceId,
    })
    .from(accountingPostingRequests)
    .where(
      and(
        eq(accountingPostingRequests.companyId, companyId),
        eq(accountingPostingRequests.idempotencyKey, idempotencyKey)
      )
    )
    .limit(1);
  if (!marker) return null;

  const expectedSourceId = goldenCoastPhase10SourceId(settlementDigest);
  if (String(marker.sourceId ?? "") !== expectedSourceId) {
    throw new GoldenCoastPhase10RouteError(
      "clientRequestId was already used for a different Fresh Start payment payload",
      "GC_PHASE10_IDEMPOTENCY_CONFLICT",
      409
    );
  }

  const [voucher] = await tx
    .select()
    .from(vouchers)
    .where(
      and(eq(vouchers.id, Number(marker.voucherId)), eq(vouchers.companyId, companyId), isNull(vouchers.deletedAt))
    )
    .limit(1);
  if (!voucher) {
    throw new GoldenCoastPhase10RouteError(
      "The Phase 10 idempotency marker references a missing or deleted voucher",
      "GC_PHASE10_IDEMPOTENCY_INCONSISTENT",
      409
    );
  }
  const entries = await loadVoucherEntries(tx, Number(voucher.id));
  const chargesFee = new Decimal(settlement.transferFeeUsd).greaterThan(0);
  const cashOutflowUsd = new Decimal(settlement.amountUsd).plus(settlement.transferFeeUsd).toFixed(2);
  if (entries.length !== (chargesFee ? 3 : 2) || !amountEquals(voucher.totalAmount, cashOutflowUsd)) {
    throw new GoldenCoastPhase10RouteError(
      "The persisted Phase 10 voucher no longer matches its idempotency marker",
      "GC_PHASE10_IDEMPOTENCY_INCONSISTENT",
      409
    );
  }

  // A Phase 10 payment debits the payable and credits the paying cash account.
  const salesCashDebit = entries.find(
    (entry) =>
      Number(entry.ledgerAccountId ?? 0) === gcSalesCashAccountId &&
      amountEquals(entry.debitAmount, settlement.amountUsd) &&
      amountEquals(entry.creditAmount, "0")
  );
  const paymentCredit = entries.find((entry) => {
    const targetMatches =
      settlement.paymentAccount.kind === "bank"
        ? Number(entry.bankAccountId ?? 0) === settlement.paymentAccount.id
        : Number(entry.ledgerAccountId ?? 0) === settlement.paymentAccount.id;
    // The paying account funds the settlement AND any transfer fee.
    return targetMatches && amountEquals(entry.debitAmount, "0") && amountEquals(entry.creditAmount, cashOutflowUsd);
  });
  const feeDebit = !chargesFee
    ? true
    : entries.some(
        (entry) =>
          Number(entry.ledgerAccountId ?? 0) !== gcSalesCashAccountId &&
          amountEquals(entry.debitAmount, settlement.transferFeeUsd) &&
          amountEquals(entry.creditAmount, "0")
      );
  if (!salesCashDebit || !paymentCredit || !feeDebit) {
    throw new GoldenCoastPhase10RouteError(
      "The persisted Phase 10 voucher entries no longer match the requested Fresh Start payment routing",
      "GC_PHASE10_IDEMPOTENCY_INCONSISTENT",
      409
    );
  }
  return { voucher, entries };
}

function respondKnownError(res: Response, error: unknown): boolean {
  if (error instanceof GoldenCoastPhase10RouteError) {
    res.status(error.status).json({ code: error.code, message: error.message });
    return true;
  }
  if (error instanceof GoldenCoastPhase10SettlementError) {
    const status =
      error.code === "GC_PHASE10_SETTLEMENT_EXCEEDS_BALANCE" || error.code === "GC_PHASE10_BALANCE_INVALID" ? 409 : 400;
    res.status(status).json({ code: error.code, message: error.message });
    return true;
  }
  if (error instanceof PostingValidationError) {
    res.status(400).json({ code: error.code, message: releaseDebtEnglish(error.message) });
    return true;
  }
  return false;
}

async function handleReadiness(req: Request, res: Response): Promise<void> {
  try {
    const companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    if (!(await isGoldenCoastCompany(db, companyId))) {
      res.status(409).json({
        code: "GC_PHASE10_NOT_CONFIGURED",
        message: releaseDebtEnglish("Golden Coast account setup is not configured."),
      });
      return;
    }
    await assertPhase10CutoverPosted(db, companyId);
    const gcSalesCashAccount = await resolveGcSalesCashAccount(db, companyId);
    const [balanceUsd, paymentAccounts, sharedChargesAccount] = await Promise.all([
      gcSalesCashDebitBalance(db, companyId, gcSalesCashAccount.id),
      listPaymentAccounts(db, companyId),
      resolveSharedChargesAccount(db, companyId, false),
    ]);
    const rawBalance = new Decimal(balanceUsd).toDecimalPlaces(2);
    // Credit-normal payable: positive is still owed, negative means overpaid.
    // The settleable figure floors that at zero so an overpaid account never
    // invites a further payment.
    const payableBalanceUsd = gcSalesCashPayableBalance(rawBalance.toFixed());
    const payableBalance = gcSalesCashSettleablePayable(payableBalanceUsd);
    res.json({
      ready: paymentAccounts.length > 0 && new Decimal(payableBalance).gt(0),
      companyId,
      gcSalesCashAccount,
      // The panel reads settleableSalesCashUsd / rawSalesCashPayableBalanceUsd /
      // receiptAccounts. The older payableSalesCashUsd, rawSalesCashDebitBalanceUsd
      // and paymentAccounts spellings stay on the payload so already-shipped
      // mobile and desktop builds keep reading the same readiness response.
      settleableSalesCashUsd: payableBalance,
      payableSalesCashUsd: payableBalance,
      rawSalesCashPayableBalanceUsd: payableBalanceUsd,
      rawSalesCashDebitBalanceUsd: rawBalance.toFixed(2),
      // A transfer fee can only be charged when Shared Charges is configured.
      sharedChargesAccount,
      receiptAccounts: paymentAccounts,
      paymentAccounts,
      sourceType: GOLDEN_COAST_PHASE10_SOURCE_TYPE,
    });
  } catch (error: unknown) {
    logger.error("Golden Coast Phase 10 readiness failed", { error });
    if (respondKnownError(res, error)) return;
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

async function handleSettlement(req: Request, res: Response): Promise<void> {
  try {
    const companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    if (!(await isGoldenCoastCompany(db, companyId))) {
      res.status(409).json({
        code: "GC_PHASE10_NOT_CONFIGURED",
        message: releaseDebtEnglish("Golden Coast account setup is not configured."),
      });
      return;
    }
    const settlement = parseGoldenCoastPhase10SettlementInput({
      companyId,
      body: req.body,
    });
    const actor = actorFromRequest(req);

    const outcome = await db.transaction(async (tx) => {
      // Phase 7 HADI payments and Phase 10 direct payments can both reduce the
      // GC Sales Cash tracker. Serialize them against the same company lock.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`golden-coast-phase7:${companyId}`}))`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`golden-coast-phase10:${companyId}`}))`);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`golden-coast-phase10:${companyId}:${settlement.clientRequestId}`}))`
      );
      if (!(await isGoldenCoastCompany(tx, companyId))) {
        throw new GoldenCoastPhase10RouteError(
          "Golden Coast account setup is not configured",
          "GC_PHASE10_NOT_CONFIGURED",
          409
        );
      }

      await assertPhase10CutoverPosted(tx, companyId);
      const gcSalesCashAccount = await resolveGcSalesCashAccount(tx, companyId);
      await validatePaymentAccount(tx, companyId, settlement.paymentAccount);

      // Shared Charges is only resolved — and only required — when the payment
      // actually carries a transfer fee.
      const sharedChargesAccount = new Decimal(settlement.transferFeeUsd).greaterThan(0)
        ? await resolveSharedChargesAccount(tx, companyId, true)
        : null;
      const settlementDigest = goldenCoastPhase10SettlementDigest({
        settlement,
        gcSalesCashAccountId: gcSalesCashAccount.id,
        sharedChargesAccountId: sharedChargesAccount?.id ?? null,
      });
      const replayed = await findReplayedSettlement(tx, companyId, settlement, gcSalesCashAccount.id, settlementDigest);
      if (replayed) {
        const currentBalance = await gcSalesCashDebitBalance(tx, companyId, gcSalesCashAccount.id);
        const payable = gcSalesCashSettleablePayable(gcSalesCashPayableBalance(currentBalance));
        return {
          replayed: true as const,
          settlement,
          gcSalesCashAccount,
          gcSalesCashDebitBalanceAfterUsd: new Decimal(currentBalance).toDecimalPlaces(2).toFixed(2),
          gcSalesCashPayableAfterUsd: payable,
          cashOutflowUsd: new Decimal(settlement.amountUsd).plus(settlement.transferFeeUsd).toFixed(2),
          voucher: replayed.voucher,
          entries: replayed.entries,
        };
      }

      // Prevent any concurrent voucher writer from changing the capped payable
      // between the balance read and the Phase 10 posting commit.
      await tx.execute(sql`LOCK TABLE voucher_entries IN SHARE ROW EXCLUSIVE MODE`);

      const datedBalanceUsd = await gcSalesCashDebitBalance(
        tx,
        companyId,
        gcSalesCashAccount.id,
        settlement.settlementDate
      );
      const allPostedBalanceUsd = await gcSalesCashDebitBalance(tx, companyId, gcSalesCashAccount.id);
      // Both values are signed Dr-minus-Cr. For a credit payable, the larger
      // (less negative) balance is the smaller safe amount payable now: a
      // future-dated sale cannot be paid early, and an already-posted later
      // payment can never be ignored.
      const gcSalesCashDebitBalanceUsd = Decimal.max(
        new Decimal(datedBalanceUsd),
        new Decimal(allPostedBalanceUsd)
      ).toString();
      const plan = planGoldenCoastPhase10Settlement({
        settlement,
        gcSalesCashDebitBalanceUsd,
      });
      const request = buildGoldenCoastPhase10SettlementPosting({
        plan,
        gcSalesCashAccountId: gcSalesCashAccount.id,
        sharedChargesAccountId: sharedChargesAccount?.id ?? null,
        settlementDigest,
        actor,
      });
      const posted = await postBalancedVoucherTx(tx, request, postingDependencies);
      return {
        replayed: posted.replayed,
        settlement,
        plan,
        gcSalesCashAccount,
        gcSalesCashDebitBalanceAfterUsd: plan.gcSalesCashDebitBalanceAfterUsd,
        gcSalesCashPayableAfterUsd: plan.gcSalesCashPayableAfterUsd,
        cashOutflowUsd: plan.cashOutflowUsd,
        voucher: posted.voucher,
        entries: posted.entries,
      };
    });

    res.status(outcome.replayed ? 200 : 201).json({
      ok: true,
      replayed: outcome.replayed,
      companyId,
      clientRequestId: outcome.settlement.clientRequestId,
      amountUsd: outcome.settlement.amountUsd,
      transferFeeUsd: outcome.settlement.transferFeeUsd,
      cashOutflowUsd: outcome.cashOutflowUsd,
      gcSalesCashDebitBalanceAfterUsd: outcome.gcSalesCashDebitBalanceAfterUsd,
      gcSalesCashPayableAfterUsd: outcome.gcSalesCashPayableAfterUsd,
      gcSalesCashAccountId: outcome.gcSalesCashAccount.id,
      voucher: outcome.voucher,
      entries: outcome.entries,
    });
  } catch (error: unknown) {
    logger.error("Golden Coast Phase 10 Fresh Start payment failed", { error });
    if (respondKnownError(res, error)) return;
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

export function registerSpGoldenCoastPhase10SalesCashSettlementRoutes(app: Express): void {
  app.get(
    "/api/sp/golden-coast/phase10/sales-cash-settlement/readiness",
    privilegedReadRateLimit,
    requireAuth,
    requireNonPOS,
    (req, res) => void handleReadiness(req, res)
  );

  app.post(
    "/api/sp/golden-coast/phase10/sales-cash-settlement",
    privilegedMutationRateLimit,
    phase10RequestBudget,
    requireAuth,
    requireNonPOS,
    (req, res) => void handleSettlement(req, res)
  );
}
