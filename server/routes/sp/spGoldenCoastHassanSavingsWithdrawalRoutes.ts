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
} from "../../services/accounting/goldenCoastAccounts";
import {
  GOLDEN_COAST_PHASE9_SOURCE_TYPE,
  GoldenCoastPhase9WithdrawalError,
  buildGoldenCoastPhase9WithdrawalPosting,
  goldenCoastPhase9IdempotencyKey,
  goldenCoastPhase9SourceId,
  goldenCoastPhase9WithdrawalDigest,
  parseGoldenCoastPhase9WithdrawalInput,
  planGoldenCoastPhase9Withdrawal,
  type GoldenCoastPhase9CashAccount,
  type GoldenCoastPhase9WithdrawalInput,
} from "../../services/accounting/goldenCoastHassanSavingsWithdrawal";
import { isGoldenCoastCompany, type DbLike } from "./spGoldenCoastCutoverFifoRoutes";
import { requireSpCompany } from "./spHelpers";

const postingDependencies = createDatabasePostingDependencies();
const phase9RequestBudget = privilegedRequestBudget({ maxBodyBytes: 16 * 1024, maxCollectionItems: 10 });
const PHASE9_ROLE = "hassan_savings" as const satisfies GoldenCoastAccountRole;

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

class GoldenCoastPhase9RouteError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = "GC_PHASE9_WITHDRAWAL_INVALID", status = 400) {
    super(releaseDebtEnglish(message));
    this.name = "GoldenCoastPhase9RouteError";
    this.code = code;
    this.status = status;
  }
}

function actorFromRequest(req: Request): PostingActor {
  return {
    userId: req.user?.id ?? req.session.userId ?? null,
    username: req.session.username ?? null,
    reason: typeof req.body?.reason === "string" ? req.body.reason.trim() : "Golden Coast Phase 9 withdrawal",
  };
}

async function resolveHassanSavingsAccount(
  conn: DbLike,
  companyId: number
): Promise<{ id: number; name: string; accountType: string }> {
  const definition = getGoldenCoastAccountDefinition(PHASE9_ROLE);
  const rows = await conn
    .select({ id: ledgerAccounts.id, name: ledgerAccounts.name, accountType: ledgerAccounts.accountType })
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
    throw new GoldenCoastPhase9RouteError(
      rows.length === 0
        ? "Hassan Savings is not configured; run Golden Coast account setup first"
        : "Hassan Savings is ambiguous; repair duplicate canonical accounts before withdrawing",
      "GC_PHASE9_ACCOUNT_INVALID",
      409
    );
  }
  const account = { id: Number(rows[0].id), name: String(rows[0].name), accountType: String(rows[0].accountType) };
  if (!definition.acceptedAccountTypes.includes(account.accountType)) {
    throw new GoldenCoastPhase9RouteError(
      `Hassan Savings must use account type ${definition.acceptedAccountTypes.join(" or ")}, not ${account.accountType}`,
      "GC_PHASE9_ACCOUNT_INVALID",
      409
    );
  }
  return account;
}

async function validatePaymentAccount(
  conn: DbLike,
  companyId: number,
  account: GoldenCoastPhase9CashAccount
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
      throw new GoldenCoastPhase9RouteError(
        "paymentAccount must reference an active bank account in the selected Golden Coast company",
        "GC_PHASE9_PAYMENT_ACCOUNT_INVALID",
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
    throw new GoldenCoastPhase9RouteError(
      "paymentAccount must reference an active Cash/Bank ledger account in the selected Golden Coast company",
      "GC_PHASE9_PAYMENT_ACCOUNT_INVALID",
      400
    );
  }
}

async function listPaymentAccounts(conn: DbLike, companyId: number) {
  const [ledgerRows, bankRows] = await Promise.all([
    conn
      .select({ id: ledgerAccounts.id, name: ledgerAccounts.name, accountType: ledgerAccounts.accountType })
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
    ...bankRows.map((row) => ({ kind: "bank" as const, id: Number(row.id), name: row.name, type: "Bank Account" })),
  ];
}

/** Credit-minus-debit is the withdrawable amount on the Hassan Savings loan at the requested accounting date. */
async function hassanSavingsCreditBalance(
  conn: DbLike,
  companyId: number,
  accountId: number,
  cutoffDate?: string
): Promise<string> {
  const query = await conn.execute(sql`
    SELECT (
      CASE
        WHEN la.opening_balance_side = 'Dr' THEN -COALESCE(la.opening_balance, 0)::numeric
        ELSE COALESCE(la.opening_balance, 0)::numeric
      END
      + COALESCE((
        SELECT SUM(CAST(ve.credit_amount AS numeric) - CAST(ve.debit_amount AS numeric))
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id
        WHERE ve.ledger_account_id = ${accountId}
          AND v.company_id = ${companyId}
          AND v.deleted_at IS NULL
          AND COALESCE(v.optional, false) = false
          AND COALESCE(v.effective_date, v.voucher_date) <= COALESCE(${cutoffDate ?? null}::date, CURRENT_DATE)
      ), 0)
    )::text AS credit_minus_debit
    FROM ledger_accounts la
    WHERE la.id = ${accountId}
      AND la.company_id = ${companyId}
      AND la.active = true
      AND la.deleted_at IS NULL
    LIMIT 1
  `);
  const row = resultRows(query)[0];
  if (!row) {
    throw new GoldenCoastPhase9RouteError(
      "Hassan Savings disappeared while its balance was being read",
      "GC_PHASE9_ACCOUNT_INVALID",
      409
    );
  }
  return String(row.credit_minus_debit ?? "0");
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

async function findReplayedWithdrawal(
  tx: DatabaseTransaction,
  companyId: number,
  withdrawal: GoldenCoastPhase9WithdrawalInput,
  hassanSavingsAccountId: number,
  withdrawalDigest: string
) {
  const idempotencyKey = goldenCoastPhase9IdempotencyKey(companyId, withdrawal.clientRequestId);
  const [marker] = await tx
    .select({ voucherId: accountingPostingRequests.voucherId, sourceId: accountingPostingRequests.sourceId })
    .from(accountingPostingRequests)
    .where(
      and(
        eq(accountingPostingRequests.companyId, companyId),
        eq(accountingPostingRequests.idempotencyKey, idempotencyKey)
      )
    )
    .limit(1);
  if (!marker) return null;

  const expectedSourceId = goldenCoastPhase9SourceId(withdrawalDigest);
  if (String(marker.sourceId ?? "") !== expectedSourceId) {
    throw new GoldenCoastPhase9RouteError(
      "clientRequestId was already used for a different Hassan Savings withdrawal payload",
      "GC_PHASE9_IDEMPOTENCY_CONFLICT",
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
    throw new GoldenCoastPhase9RouteError(
      "The Phase 9 idempotency marker references a missing or deleted voucher",
      "GC_PHASE9_IDEMPOTENCY_INCONSISTENT",
      409
    );
  }
  const entries = await loadVoucherEntries(tx, Number(voucher.id));
  if (entries.length !== 2 || !amountEquals(voucher.totalAmount, withdrawal.amountUsd)) {
    throw new GoldenCoastPhase9RouteError(
      "The persisted Phase 9 voucher no longer matches its idempotency marker",
      "GC_PHASE9_IDEMPOTENCY_INCONSISTENT",
      409
    );
  }

  const savingsDebit = entries.find(
    (entry) =>
      Number(entry.ledgerAccountId ?? 0) === hassanSavingsAccountId &&
      amountEquals(entry.debitAmount, withdrawal.amountUsd) &&
      amountEquals(entry.creditAmount, "0")
  );
  const paymentCredit = entries.find((entry) => {
    const targetMatches =
      withdrawal.paymentAccount.kind === "bank"
        ? Number(entry.bankAccountId ?? 0) === withdrawal.paymentAccount.id
        : Number(entry.ledgerAccountId ?? 0) === withdrawal.paymentAccount.id;
    return (
      targetMatches && amountEquals(entry.creditAmount, withdrawal.amountUsd) && amountEquals(entry.debitAmount, "0")
    );
  });
  if (!savingsDebit || !paymentCredit) {
    throw new GoldenCoastPhase9RouteError(
      "The persisted Phase 9 voucher entries no longer match the requested withdrawal routing",
      "GC_PHASE9_IDEMPOTENCY_INCONSISTENT",
      409
    );
  }
  return { voucher, entries };
}

function respondKnownError(res: Response, error: unknown): boolean {
  if (error instanceof GoldenCoastPhase9RouteError) {
    res.status(error.status).json({ code: error.code, message: error.message });
    return true;
  }
  if (error instanceof GoldenCoastPhase9WithdrawalError) {
    const status =
      error.code === "GC_PHASE9_WITHDRAWAL_EXCEEDS_SAVINGS" || error.code === "GC_PHASE9_BALANCE_INVALID" ? 409 : 400;
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
        code: "GC_PHASE9_NOT_CONFIGURED",
        message: releaseDebtEnglish("Golden Coast account setup is not configured."),
      });
      return;
    }
    const savingsAccount = await resolveHassanSavingsAccount(db, companyId);
    const [savingsBalanceUsd, paymentAccounts] = await Promise.all([
      hassanSavingsCreditBalance(db, companyId, savingsAccount.id),
      listPaymentAccounts(db, companyId),
    ]);
    const normalizedBalance = new Decimal(savingsBalanceUsd).toDecimalPlaces(2).toFixed(2);
    res.json({
      ready: paymentAccounts.length > 0 && new Decimal(normalizedBalance).gte(0),
      companyId,
      hassanSavingsAccount: savingsAccount,
      availableSavingsUsd: normalizedBalance,
      paymentAccounts,
      sourceType: GOLDEN_COAST_PHASE9_SOURCE_TYPE,
    });
  } catch (error: unknown) {
    logger.error("Golden Coast Phase 9 readiness failed", { error });
    if (respondKnownError(res, error)) return;
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

async function handleWithdrawal(req: Request, res: Response): Promise<void> {
  try {
    const companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    if (!(await isGoldenCoastCompany(db, companyId))) {
      res.status(409).json({
        code: "GC_PHASE9_NOT_CONFIGURED",
        message: releaseDebtEnglish("Golden Coast account setup is not configured."),
      });
      return;
    }
    const withdrawal = parseGoldenCoastPhase9WithdrawalInput({ companyId, body: req.body });
    const actor = actorFromRequest(req);

    const outcome = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`golden-coast-phase9:${companyId}`}))`);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`golden-coast-phase9:${companyId}:${withdrawal.clientRequestId}`}))`
      );
      if (!(await isGoldenCoastCompany(tx, companyId))) {
        throw new GoldenCoastPhase9RouteError(
          "Golden Coast account setup is not configured",
          "GC_PHASE9_NOT_CONFIGURED",
          409
        );
      }

      const savingsAccount = await resolveHassanSavingsAccount(tx, companyId);
      await validatePaymentAccount(tx, companyId, withdrawal.paymentAccount);
      if (withdrawal.paymentAccount.kind === "ledger" && withdrawal.paymentAccount.id === savingsAccount.id) {
        throw new GoldenCoastPhase9RouteError(
          "paymentAccount cannot be the Hassan Savings account itself",
          "GC_PHASE9_PAYMENT_ACCOUNT_INVALID",
          400
        );
      }

      const withdrawalDigest = goldenCoastPhase9WithdrawalDigest({
        withdrawal,
        hassanSavingsAccountId: savingsAccount.id,
      });
      const replayed = await findReplayedWithdrawal(tx, companyId, withdrawal, savingsAccount.id, withdrawalDigest);
      if (replayed) {
        const currentBalance = await hassanSavingsCreditBalance(
          tx,
          companyId,
          savingsAccount.id,
          withdrawal.withdrawalDate
        );
        return {
          replayed: true as const,
          withdrawal,
          savingsAccount,
          savingsBalanceAfterUsd: new Decimal(currentBalance).toDecimalPlaces(2).toFixed(2),
          voucher: replayed.voucher,
          entries: replayed.entries,
        };
      }

      // Serialize the balance cap against every voucher-entry writer. This database table lock
      // conflicts with the ROW EXCLUSIVE lock taken by all voucher entry inserts, including
      // manual journals and non-Phase-9 accounting routes, so the balance cannot change between
      // this cap check and the Phase 9 posting commit.
      await tx.execute(sql`LOCK TABLE voucher_entries IN SHARE ROW EXCLUSIVE MODE`);

      const savingsBalanceUsd = await hassanSavingsCreditBalance(
        tx,
        companyId,
        savingsAccount.id,
        withdrawal.withdrawalDate
      );
      const plan = planGoldenCoastPhase9Withdrawal({ withdrawal, savingsBalanceUsd });
      const request = buildGoldenCoastPhase9WithdrawalPosting({
        plan,
        hassanSavingsAccountId: savingsAccount.id,
        withdrawalDigest,
        actor,
      });
      const posted = await postBalancedVoucherTx(tx, request, postingDependencies);
      return {
        replayed: posted.replayed,
        withdrawal,
        plan,
        savingsAccount,
        savingsBalanceAfterUsd: plan.savingsBalanceAfterUsd,
        voucher: posted.voucher,
        entries: posted.entries,
      };
    });

    res.status(outcome.replayed ? 200 : 201).json({
      ok: true,
      replayed: outcome.replayed,
      companyId,
      clientRequestId: outcome.withdrawal.clientRequestId,
      amountUsd: outcome.withdrawal.amountUsd,
      availableSavingsAfterUsd: outcome.savingsBalanceAfterUsd,
      hassanSavingsAccountId: outcome.savingsAccount.id,
      voucher: outcome.voucher,
      entries: outcome.entries,
    });
  } catch (error: unknown) {
    logger.error("Golden Coast Phase 9 Hassan Savings withdrawal failed", { error });
    if (respondKnownError(res, error)) return;
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

export function registerSpGoldenCoastPhase9HassanSavingsWithdrawalRoutes(app: Express): void {
  app.get(
    "/api/sp/golden-coast/phase9/hassan-savings-withdrawal/readiness",
    privilegedReadRateLimit,
    requireAuth,
    requireNonPOS,
    (req, res) => void handleReadiness(req, res)
  );

  app.post(
    "/api/sp/golden-coast/phase9/hassan-savings-withdrawal",
    privilegedMutationRateLimit,
    phase9RequestBudget,
    requireAuth,
    requireNonPOS,
    (req, res) => void handleWithdrawal(req, res)
  );
}
