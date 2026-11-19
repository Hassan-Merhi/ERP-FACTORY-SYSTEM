import type { Express, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { voucherEntries } from "@shared/schema";
import { requireAuth, requireRole } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { privilegedMutationRateLimit, privilegedReadRateLimit } from "../../middleware/privilegedEndpointSecurity";
import { PostingValidationError, postBalancedVoucherTx } from "../../services/accounting/centralPostingEngine";
import { buildGenericVoucherPostingRequest } from "../../services/accounting/genericVoucherPosting";
import { summarizeGoldenCoastAccountSetup } from "../../services/accounting/goldenCoastPhase2Accounts";
import {
  GOLDEN_COAST_PHASE3_CUTOVER_DATE,
  GoldenCoastPhase3CutoverError,
  buildGoldenCoastPhase3CutoverPlan,
} from "../../services/accounting/goldenCoastPhase3Cutover";
import { requireSpCompany } from "./spHelpers";
import { loadGoldenCoastAccounts, loadGoldenCoastSettings } from "./spGoldenCoastSetupRoutes";
import {
  GoldenCoastPhase3RouteError,
  businessDate,
  canonicalPreCutoverBalances,
  parseCashAccount,
  phase3RequestBudget,
  postingDependencies,
  resolveRoleAccounts,
  validateCashAccountTx,
  type PersistedPostingResult,
} from "./canonicalPreCutoverBalances";
import { readiness } from "./spGoldenCoastPhase3CutoverRoutesReadiness";
import { z } from "zod";
import { validateRequest, type RequestSchemas } from "../../lib/validateRequest";
import { amountish, numberish, spWriteFields } from "./spRequestSchemas";

function respondKnownError(res: Response, error: unknown): boolean {
  if (error instanceof GoldenCoastPhase3RouteError) {
    res.status(error.status).json({ message: error.message, code: error.code });
    return true;
  }
  if (error instanceof GoldenCoastPhase3CutoverError) {
    res.status(400).json({ message: error.message, code: "GC_PHASE3_CUTOVER_INVALID" });
    return true;
  }
  if (error instanceof PostingValidationError) {
    res
      .status(error.code === "POSTING_IDEMPOTENCY_CORRUPT" ? 409 : 400)
      .json({ message: error.message, code: error.code });
    return true;
  }
  return false;
}

async function handleStatus(req: Request, res: Response): Promise<void> {
  try {
    const companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    res.json(await readiness(db, companyId));
  } catch (error) {
    if (respondKnownError(res, error)) return;
    logger.error("Golden Coast Phase 3 status failed", { error });
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

async function handlePreview(req: Request, res: Response): Promise<void> {
  try {
    const companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    const [accounts, settings] = await Promise.all([
      loadGoldenCoastAccounts(db, companyId),
      loadGoldenCoastSettings(db, companyId),
    ]);
    const phase2 = summarizeGoldenCoastAccountSetup({ companyId, accounts, settings });
    if (!phase2.isConfigured) {
      throw new GoldenCoastPhase3RouteError(
        "Golden Coast Phase 2 account setup must be fully configured before Phase 3 can be previewed",
        "GC_PHASE3_PHASE2_NOT_READY",
        409
      );
    }
    const resolved = resolveRoleAccounts(accounts);
    const cashAccount = parseCashAccount(req.body?.cashAccount);
    await validateCashAccountTx(db, companyId, cashAccount);
    const plan = buildGoldenCoastPhase3CutoverPlan({
      companyId,
      stockOtwUsd: req.body?.stockOtwUsd,
      stockInHandUsd: req.body?.stockInHandUsd,
      containerReserveUsd: req.body?.containerReserveUsd,
      freshStartContributedStockOtwUsd: req.body?.freshStartContributedStockOtwUsd,
      freshStartContributedStockInHandUsd: req.body?.freshStartContributedStockInHandUsd,
      gcSalesCashUsd: req.body?.gcSalesCashUsd,
      hassanSavingsUsd: req.body?.hassanSavingsUsd,
      cashAccount,
      accounts: resolved,
    });
    res.json({ plan, readiness: await readiness(db, companyId) });
  } catch (error) {
    if (respondKnownError(res, error)) return;
    logger.error("Golden Coast Phase 3 preview failed", { error });
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

async function handlePost(req: Request, res: Response): Promise<void> {
  const startedAt = Date.now();
  let companyId: number | null = null;
  try {
    companyId = await requireSpCompany(req, res);
    if (!companyId) return;

    const requestDate = businessDate();
    if (requestDate < GOLDEN_COAST_PHASE3_CUTOVER_DATE) {
      throw new GoldenCoastPhase3RouteError(
        `Golden Coast Phase 3 cannot be posted before ${GOLDEN_COAST_PHASE3_CUTOVER_DATE}`,
        "GC_PHASE3_CUTOVER_NOT_OPEN",
        409
      );
    }

    const selectedCompany = companyId;
    const cashAccount = parseCashAccount(req.body?.cashAccount);
    const result = await db.transaction(async (tx) => {
      const state = await readiness(tx, selectedCompany);
      const existingOpeningVoucher = state.existingVoucher ?? state.existingPositionCarryForwardVoucher;
      if (existingOpeningVoucher) {
        const entries = await tx
          .select()
          .from(voucherEntries)
          .where(eq(voucherEntries.voucherId, existingOpeningVoucher.id));
        return {
          posted: { voucher: existingOpeningVoucher, entries, replayed: true } as PersistedPostingResult,
          plan: null,
        };
      }
      if (!state.canPost) {
        throw new GoldenCoastPhase3RouteError(
          state.blockers.join(" ") || "Golden Coast Phase 3 cutover is not ready",
          "GC_PHASE3_CUTOVER_BLOCKED",
          409
        );
      }

      const accounts = await loadGoldenCoastAccounts(tx, selectedCompany);
      const resolved = resolveRoleAccounts(accounts);
      await validateCashAccountTx(tx, selectedCompany, cashAccount);

      const plan = buildGoldenCoastPhase3CutoverPlan({
        companyId: selectedCompany,
        stockOtwUsd: req.body?.stockOtwUsd,
        stockInHandUsd: req.body?.stockInHandUsd,
        containerReserveUsd: req.body?.containerReserveUsd,
        freshStartContributedStockOtwUsd: req.body?.freshStartContributedStockOtwUsd,
        freshStartContributedStockInHandUsd: req.body?.freshStartContributedStockInHandUsd,
        gcSalesCashUsd: req.body?.gcSalesCashUsd,
        hassanSavingsUsd: req.body?.hassanSavingsUsd,
        cashAccount,
        accounts: resolved,
      });
      const built = buildGenericVoucherPostingRequest({
        companyId: selectedCompany,
        clientRequestId: `gc-phase3-cutover:${selectedCompany}:${GOLDEN_COAST_PHASE3_CUTOVER_DATE}`,
        voucher: {
          voucherNumber: plan.voucherNumber,
          voucherType: plan.voucherType,
          voucherDate: plan.cutoverDate,
          description: plan.description,
          currency: "USD",
        },
        entries: plan.entries,
        exchangeRate: null,
        actor: {
          userId: req.session.userId ?? null,
          username: req.session.username || "unknown",
          reason: String(req.body?.reason ?? "Golden Coast Phase 3 opening-balance cutover"),
        },
      });
      const posted = (await postBalancedVoucherTx(tx, built.request, postingDependencies)) as PersistedPostingResult;
      return { posted, plan };
    });

    logger.info("Golden Coast Phase 3 cutover posting succeeded", {
      module: "golden-coast-phase3",
      companyId: selectedCompany,
      voucherId: result.posted.voucher.id,
      replayed: result.posted.replayed,
      durationMs: Date.now() - startedAt,
    });
    res.json({
      success: true,
      cutoverDate: GOLDEN_COAST_PHASE3_CUTOVER_DATE,
      voucher: result.posted.voucher,
      entries: result.posted.entries,
      replayed: result.posted.replayed,
      plan: result.plan,
    });
  } catch (error) {
    if (respondKnownError(res, error)) return;
    logger.error("Golden Coast Phase 3 cutover posting failed", {
      module: "golden-coast-phase3",
      companyId,
      durationMs: Date.now() - startedAt,
      error,
    });
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

// Read by handlePreview / handlePost (parseCashAccount, buildGoldenCoastPhase3CutoverPlan).
const phase3Body = z.strictObject({
  ...spWriteFields,
  cashAccount: z
    .strictObject({ kind: z.string(), id: numberish, name: z.string().nullable().optional() })
    .nullable()
    .optional(),
  stockOtwUsd: amountish.nullable().optional(),
  stockInHandUsd: amountish.nullable().optional(),
  containerReserveUsd: amountish.nullable().optional(),
  freshStartContributedStockOtwUsd: amountish.nullable().optional(),
  freshStartContributedStockInHandUsd: amountish.nullable().optional(),
  gcSalesCashUsd: amountish.nullable().optional(),
  hassanSavingsUsd: amountish.nullable().optional(),
});

const phase3PreviewInput = { body: phase3Body } satisfies RequestSchemas;
const phase3CutoverInput = { body: phase3Body } satisfies RequestSchemas;

export function registerSpGoldenCoastPhase3CutoverRoutes(app: Express): void {
  app.get(
    "/api/sp/golden-coast/phase3/status",
    privilegedReadRateLimit,
    requireAuth,
    requireRole("Admin"),
    (req, res) => {
      void handleStatus(req, res);
    }
  );
  app.post(
    "/api/sp/golden-coast/phase3/preview",
    privilegedReadRateLimit,
    phase3RequestBudget,
    requireAuth,
    requireRole("Admin"),
    validateRequest(phase3PreviewInput),
    (req, res) => {
      void handlePreview(req, res);
    }
  );
  // `cutover` in the path deliberately activates the existing SP sensitive-action
  // guard: exact confirmation "RUN SP MIGRATION", reason >= 5 characters and a
  // unique idempotency key are required before this handler can run.
  app.post(
    "/api/sp/golden-coast/phase3/cutover",
    privilegedMutationRateLimit,
    phase3RequestBudget,
    requireAuth,
    requireRole("Admin"),
    validateRequest(phase3CutoverInput),
    (req, res) => {
      void handlePost(req, res);
    }
  );
}

export { businessDate, canonicalPreCutoverBalances, parseCashAccount, resolveRoleAccounts };
