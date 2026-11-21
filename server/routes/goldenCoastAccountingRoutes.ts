import type { Express, Request, Response } from "express";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { bankAccounts, ledgerAccounts } from "@shared/schema";
import { requireAuth, requireNonPOS, requireRole } from "../auth";
import { db } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import {
  privilegedMutationRateLimit,
  privilegedReadRateLimit,
  privilegedRequestBudget,
} from "../middleware/privilegedEndpointSecurity";
import { PostingValidationError, postBalancedVoucherTx } from "../services/accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../services/accounting/databasePostingDependencies";
import {
  GoldenCoastPhase1InputError,
  getGoldenCoastPhase1CashRoleRequirements,
  getGoldenCoastPhase1LedgerRoleRequirements,
} from "../services/accounting/goldenCoastPhase1Posting";
import { buildGoldenCoastPhase1PostingBatch } from "../services/accounting/goldenCoastPhase1PostingBatch";
import { buildVoucherChangesForCreate, getCurrentExchangeRate, logAudit, snapshotVoucherEntries } from "./_helpers";
import {
  assertGoldenCoastAccountingCompany,
  selectedCompanyId,
  handlePhase1SetupAccounts,
  handlePhase1Preview,
  handlePhase1Accounts,
  type PersistedPostingResult,
  type DatabaseTransaction,
} from "./goldenCoastAccountingRoutesHelpers";

const postingDependencies = createDatabasePostingDependencies();
const phase1RequestBudget = privilegedRequestBudget({ maxBodyBytes: 64 * 1024, maxCollectionItems: 50 });

function validationStatus(error: PostingValidationError): number {
  return error.code === "POSTING_IDEMPOTENCY_CORRUPT" ? 409 : 400;
}

async function validatePhase1LedgerRolesTx(tx: DatabaseTransaction, companyId: number, event: unknown): Promise<void> {
  const requirements = getGoldenCoastPhase1LedgerRoleRequirements(event);
  if (requirements.length === 0) return;

  const accountIds = [...new Set(requirements.map((requirement) => requirement.accountId))];
  const rows = await tx
    .select({ id: ledgerAccounts.id, name: ledgerAccounts.name, subType: ledgerAccounts.subType })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        inArray(ledgerAccounts.id, accountIds),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt)
      )
    );
  const byId = new Map(rows.map((row) => [Number(row.id), row]));

  for (const requirement of requirements) {
    const account = byId.get(requirement.accountId);
    if (!account) {
      throw new GoldenCoastPhase1InputError(`${requirement.label} is not an active ledger account in this company`);
    }
    if (!account.subType || !requirement.allowedSubTypes.includes(account.subType)) {
      throw new GoldenCoastPhase1InputError(
        `${requirement.label} must use ${requirement.allowedSubTypes.join(" or ")}; account "${account.name}" is ${account.subType ?? "untyped"}`
      );
    }
  }
}

async function validatePhase1CashRolesTx(tx: DatabaseTransaction, companyId: number, event: unknown): Promise<void> {
  const requirements = getGoldenCoastPhase1CashRoleRequirements(event);
  if (requirements.length === 0) return;

  const ledgerIds = [
    ...new Set(
      requirements
        .filter((requirement) => requirement.account.kind === "ledger")
        .map((requirement) => requirement.account.id)
    ),
  ];
  const bankIds = [
    ...new Set(
      requirements
        .filter((requirement) => requirement.account.kind === "bank")
        .map((requirement) => requirement.account.id)
    ),
  ];

  const ledgerRows =
    ledgerIds.length === 0
      ? []
      : await tx
          .select({ id: ledgerAccounts.id, name: ledgerAccounts.name, accountType: ledgerAccounts.accountType })
          .from(ledgerAccounts)
          .where(
            and(
              eq(ledgerAccounts.companyId, companyId),
              inArray(ledgerAccounts.id, ledgerIds),
              inArray(ledgerAccounts.accountType, ["Cash", "Bank"]),
              eq(ledgerAccounts.active, true),
              isNull(ledgerAccounts.deletedAt)
            )
          );
  const bankRows =
    bankIds.length === 0
      ? []
      : await tx
          .select({ id: bankAccounts.id, name: bankAccounts.name })
          .from(bankAccounts)
          .where(
            and(
              eq(bankAccounts.companyId, companyId),
              inArray(bankAccounts.id, bankIds),
              eq(bankAccounts.active, true),
              isNull(bankAccounts.deletedAt)
            )
          );

  const validLedgerIds = new Set(ledgerRows.map((row) => Number(row.id)));
  const validBankIds = new Set(bankRows.map((row) => Number(row.id)));

  for (const requirement of requirements) {
    const valid =
      requirement.account.kind === "bank"
        ? validBankIds.has(requirement.account.id)
        : validLedgerIds.has(requirement.account.id);
    if (!valid) {
      throw new GoldenCoastPhase1InputError(
        `${requirement.label} must reference an active company bank or Cash/Bank ledger account`
      );
    }
  }
}

async function handlePhase1Post(req: Request, res: Response): Promise<void> {
  const startedAt = Date.now();
  let companyId: number | null = null;
  const userId = req.session.userId;

  try {
    companyId = selectedCompanyId(req);
    await assertGoldenCoastAccountingCompany(companyId);
    const selectedCompany = companyId;
    const exchangeRate = await getCurrentExchangeRate(selectedCompany);

    const result = await db.transaction(async (tx) => {
      const built = buildGoldenCoastPhase1PostingBatch({
        companyId: selectedCompany,
        clientRequestId: req.body?.clientRequestId,
        voucherNumber: req.body?.voucherNumber,
        voucherDate: req.body?.voucherDate,
        event: req.body?.event,
        exchangeRate: exchangeRate != null ? String(exchangeRate) : null,
        actor: {
          userId: userId ?? null,
          username: req.session.username || "unknown",
          reason: "Golden Coast Phase 1 accounting",
        },
      });

      await validatePhase1LedgerRolesTx(tx, selectedCompany, req.body?.event);
      await validatePhase1CashRolesTx(tx, selectedCompany, req.body?.event);

      const postings: Array<{ role: "primary" | "cogs"; posted: PersistedPostingResult }> = [];
      for (const item of built.postings) {
        const posted = (await postBalancedVoucherTx(tx, item.request, postingDependencies)) as PersistedPostingResult;
        postings.push({ role: item.role, posted });
        // Wave 16 (B): audited in the posting transaction.
        if (!posted.replayed) {
          const entrySnapshot = await snapshotVoucherEntries(posted.entries, tx);
          await logAudit(
            {
              userId: userId ?? "system",
              username: req.session.username || "unknown",
              companyId: selectedCompany,
              action: "create",
              tableName: "vouchers",
              recordId: posted.voucher.id,
              recordIdentifier: posted.voucher.voucherNumber,
              changes: buildVoucherChangesForCreate(posted.voucher, entrySnapshot),
            },
            tx
          );
        }
      }

      return {
        postings,
        clientRequestId: built.clientRequestId,
        eventType: built.eventType,
      };
    });

    const primary = result.postings[0]?.posted;
    if (!primary) {
      throw new GoldenCoastPhase1InputError("Golden Coast Phase 1 posting produced no vouchers");
    }
    const replayed = result.postings.every((item) => item.posted.replayed);

    logger.info("Golden Coast Phase 1 posting succeeded", {
      module: "golden-coast-accounting",
      eventType: result.eventType,
      companyId: selectedCompany,
      userId,
      voucherIds: result.postings.map((item) => item.posted.voucher.id),
      replayed,
      durationMs: Date.now() - startedAt,
    });

    res.json({
      eventType: result.eventType,
      voucher: primary.voucher,
      entries: primary.entries,
      replayed,
      clientRequestId: result.clientRequestId,
      postings: result.postings.map((item) => ({
        role: item.role,
        voucher: item.posted.voucher,
        entries: item.posted.entries,
        replayed: item.posted.replayed,
      })),
    });
  } catch (error: unknown) {
    logger.error("Golden Coast Phase 1 posting failed", {
      module: "golden-coast-accounting",
      companyId,
      userId,
      durationMs: Date.now() - startedAt,
      error,
    });

    if (error instanceof GoldenCoastPhase1InputError) {
      res.status(400).json({ message: error.message, code: "GC_PHASE1_INPUT_INVALID" });
      return;
    }
    if (error instanceof PostingValidationError) {
      res.status(validationStatus(error)).json({ message: error.message, code: error.code });
      return;
    }
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

export function registerGoldenCoastAccountingRoutes(app: Express): void {
  app.post(
    "/api/golden-coast/accounting/phase1/setup-accounts",
    privilegedMutationRateLimit,
    phase1RequestBudget,
    requireAuth,
    requireRole("Developer"),
    (req, res) => void handlePhase1SetupAccounts(req, res)
  );
  app.get(
    "/api/golden-coast/accounting/phase1/accounts",
    privilegedReadRateLimit,
    requireAuth,
    requireNonPOS,
    (req, res) => void handlePhase1Accounts(req, res)
  );
  app.post(
    "/api/golden-coast/accounting/phase1/preview",
    privilegedReadRateLimit,
    phase1RequestBudget,
    requireAuth,
    requireNonPOS,
    (req, res) => void handlePhase1Preview(req, res)
  );
  app.post(
    "/api/golden-coast/accounting/phase1/post",
    privilegedMutationRateLimit,
    phase1RequestBudget,
    requireAuth,
    requireNonPOS,
    (req, res) => void handlePhase1Post(req, res)
  );
}
