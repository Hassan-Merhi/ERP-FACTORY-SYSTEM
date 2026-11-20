import type { Express, Request, Response } from "express";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { ledgerAccounts, spStockMovements, voucherEntries } from "@shared/schema";
import { requireAuth, requireRole } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import {
  privilegedMutationRateLimit,
  privilegedReadRateLimit,
  privilegedRequestBudget,
} from "../../middleware/privilegedEndpointSecurity";
import { postBalancedVoucherTx } from "../../services/accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../../services/accounting/databasePostingDependencies";
import { buildGenericVoucherPostingRequest } from "../../services/accounting/genericVoucherPosting";
import { goldenCoastExistingPositionCarryForwardVoucherNumber } from "../../services/accounting/goldenCoastCutoverMarkers";
import {
  buildGoldenCoastExistingPositionCarryForwardPlan,
  GoldenCoastExistingPositionCarryForwardError,
  type ExistingPositionCarryForwardAccounts,
} from "../../services/accounting/goldenCoastExistingPositionCarryForward";
import { GOLDEN_COAST_CUTOVER_DATE } from "../../services/accounting/goldenCoastPhase4CutoverFifo";
import { requireSpCompany } from "./spHelpers";
import { isGoldenCoastCompany } from "./spGoldenCoastPhase4CutoverFifoRoutes";
import {
  loadInventory,
  loadOtwContainers,
  loadExistingVoucher,
  loadExistingPhase3Voucher,
  loadExistingBridge,
  recordCarryForwardAudit,
  type DatabaseTransaction,
  type PersistedPostingResult,
} from "./spGoldenCoastExistingPositionCarryForwardRoutesHelpers";
import { z } from "zod";
import { validateRequest, type RequestSchemas } from "../../lib/validateRequest";
import { spWriteFields } from "./spRequestSchemas";

const postingDependencies = createDatabasePostingDependencies();
const requestBudget = privilegedRequestBudget({ maxBodyBytes: 16 * 1024, maxCollectionItems: 250 });

class CarryForwardRouteError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = "GC_CARRY_FORWARD_BLOCKED", status = 409) {
    super(message);
    this.name = "CarryForwardRouteError";
    this.code = code;
    this.status = status;
  }
}

function activeAccountMap(rows: Array<{ id: number; subType: string | null }>): ExistingPositionCarryForwardAccounts {
  const bySubtype = new Map(rows.map((row) => [row.subType, Number(row.id)]));
  const stockInHandAccountId = bySubtype.get("sp_stock");
  const stockOtwAccountId = bySubtype.get("sp_goods_otw");
  const openingBalanceClearingAccountId = bySubtype.get("sp_opnbal");
  if (!stockInHandAccountId || !stockOtwAccountId || !openingBalanceClearingAccountId) {
    throw new CarryForwardRouteError(
      "Golden Coast requires active Stock in Hand, Stock OTW, and Opening Balance Clearing accounts",
      "GC_CARRY_FORWARD_ACCOUNTS_NOT_READY"
    );
  }
  if (rows.length !== 3) {
    throw new CarryForwardRouteError(
      "Golden Coast carry-forward requires exactly one active account for each stock/clearing role",
      "GC_CARRY_FORWARD_ACCOUNTS_AMBIGUOUS"
    );
  }
  return { stockInHandAccountId, stockOtwAccountId, openingBalanceClearingAccountId };
}

async function loadAccounts(conn: typeof db | DatabaseTransaction, companyId: number) {
  const rows = await conn
    .select({ id: ledgerAccounts.id, subType: ledgerAccounts.subType })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        inArray(ledgerAccounts.subType, ["sp_stock", "sp_goods_otw", "sp_opnbal"]),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt)
      )
    );
  return activeAccountMap(rows.map((row) => ({ id: Number(row.id), subType: row.subType })));
}

async function buildState(conn: typeof db | DatabaseTransaction, companyId: number) {
  const [accounts, inventory, otwContainers, existingVoucher, existingPhase3Voucher, existingBridge] =
    await Promise.all([
      loadAccounts(conn, companyId),
      loadInventory(conn, companyId),
      loadOtwContainers(conn, companyId),
      loadExistingVoucher(conn, companyId),
      loadExistingPhase3Voucher(conn, companyId),
      loadExistingBridge(conn, companyId),
    ]);

  let plan: ReturnType<typeof buildGoldenCoastExistingPositionCarryForwardPlan> | null = null;
  const blockers: string[] = [];
  try {
    plan = buildGoldenCoastExistingPositionCarryForwardPlan({ companyId, accounts, inventory, otwContainers });
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : String(error));
  }

  if (existingVoucher && existingBridge.length === 0) {
    blockers.push(
      "Carry-forward journal exists but its FIFO bridge is missing; repair this partial state before retrying."
    );
  }
  if (!existingVoucher && existingBridge.length > 0) {
    blockers.push(
      "Golden Coast FIFO bridge exists without the carry-forward journal; repair this partial state before retrying."
    );
  }
  if (existingPhase3Voucher) {
    blockers.push(
      "The standard Golden Coast Phase 3 opening voucher already exists; use its Phase 4 FIFO bridge instead of applying an existing-position carry-forward."
    );
  }
  if (new Date().toISOString().slice(0, 10) < GOLDEN_COAST_CUTOVER_DATE) {
    blockers.push(`Existing-position carry-forward cannot be applied before ${GOLDEN_COAST_CUTOVER_DATE}.`);
  }

  return {
    cutoverDate: GOLDEN_COAST_CUTOVER_DATE,
    voucherNumber: goldenCoastExistingPositionCarryForwardVoucherNumber(companyId),
    existingVoucher,
    existingPhase3Voucher,
    existingBridge,
    plan,
    blockers,
    posted: Boolean(existingVoucher && existingBridge.length > 0),
    canApply:
      !existingVoucher &&
      !existingPhase3Voucher &&
      existingBridge.length === 0 &&
      blockers.length === 0 &&
      Boolean(plan),
  };
}

function actorFromRequest(req: Request) {
  return {
    userId: req.user?.id ?? req.session.userId ?? null,
    username: req.session.username ?? null,
    reason: String(req.body?.reason ?? "Golden Coast existing-position carry-forward"),
  };
}

async function handleStatus(req: Request, res: Response): Promise<void> {
  try {
    const companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    if (!(await isGoldenCoastCompany(db, companyId))) {
      res.status(409).json({
        code: "GC_CARRY_FORWARD_NOT_CONFIGURED",
        message: "Golden Coast account setup is not configured for this company",
      });
      return;
    }
    res.json(await buildState(db, companyId));
  } catch (error) {
    if (error instanceof CarryForwardRouteError || error instanceof GoldenCoastExistingPositionCarryForwardError) {
      res.status(409).json({
        code: error instanceof CarryForwardRouteError ? error.code : "GC_CARRY_FORWARD_INVALID",
        message: error.message,
      });
      return;
    }
    logger.error("Golden Coast existing-position carry-forward status failed", { error });
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

async function handleApply(req: Request, res: Response): Promise<void> {
  const startedAt = Date.now();
  let companyId: number | null = null;
  try {
    companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    const selectedCompany = companyId;
    const result = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`golden-coast-existing-position-carry-forward:${selectedCompany}`}))`
      );
      if (!(await isGoldenCoastCompany(tx, selectedCompany))) {
        throw new CarryForwardRouteError(
          "Golden Coast account setup is not configured for this company",
          "GC_CARRY_FORWARD_NOT_CONFIGURED"
        );
      }
      const state = await buildState(tx, selectedCompany);
      if (state.posted && state.existingVoucher) {
        const entries = await tx
          .select()
          .from(voucherEntries)
          .where(eq(voucherEntries.voucherId, state.existingVoucher.id));
        await recordCarryForwardAudit(tx, req, selectedCompany, state.existingVoucher.id, true);
        return { posted: { voucher: state.existingVoucher, entries } as PersistedPostingResult, state, replayed: true };
      }
      if (!state.canApply || !state.plan) {
        throw new CarryForwardRouteError(state.blockers.join(" ") || "Golden Coast carry-forward is not ready");
      }

      const plan = state.plan;
      const built = buildGenericVoucherPostingRequest({
        companyId: selectedCompany,
        clientRequestId: `gc-existing-position-carry-forward:${companyId}:${GOLDEN_COAST_CUTOVER_DATE}`,
        voucher: {
          voucherNumber: plan.voucherNumber,
          voucherType: "Journal",
          voucherDate: plan.cutoverDate,
          description: `Golden Coast existing position carry-forward — ${GOLDEN_COAST_CUTOVER_DATE}`,
          currency: "USD",
        },
        entries: plan.journalEntries,
        exchangeRate: null,
        actor: actorFromRequest(req),
      });
      const posted = (await postBalancedVoucherTx(tx, built.request, postingDependencies)) as PersistedPostingResult;
      const inserted = [];
      for (const movement of plan.fifoMovements) {
        const [row] = await tx.insert(spStockMovements).values(movement).returning();
        inserted.push(row);
      }
      await recordCarryForwardAudit(tx, req, selectedCompany, posted.voucher.id, false);
      return { posted, state: await buildState(tx, selectedCompany), inserted, replayed: false };
    });

    logger.info("Golden Coast existing-position carry-forward succeeded", {
      module: "golden-coast-existing-position-carry-forward",
      companyId,
      voucherId: result.posted.voucher.id,
      replayed: result.replayed,
      durationMs: Date.now() - startedAt,
    });
    res.json({
      success: true,
      posted: result.posted.voucher,
      entries: result.posted.entries,
      inserted: result.inserted ?? [],
      replayed: result.replayed,
      state: result.state,
    });
  } catch (error) {
    if (error instanceof CarryForwardRouteError || error instanceof GoldenCoastExistingPositionCarryForwardError) {
      res.status(409).json({
        code: error instanceof CarryForwardRouteError ? error.code : "GC_CARRY_FORWARD_INVALID",
        message: error.message,
      });
      return;
    }
    logger.error("Golden Coast existing-position carry-forward failed", {
      module: "golden-coast-existing-position-carry-forward",
      companyId,
      durationMs: Date.now() - startedAt,
      error,
    });
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

const applyCarryForwardInput = { body: z.strictObject(spWriteFields) } satisfies RequestSchemas;

export function registerSpGoldenCoastExistingPositionCarryForwardRoutes(app: Express): void {
  app.get(
    "/api/sp/golden-coast/cutover/existing-position-carry-forward",
    privilegedReadRateLimit,
    requireAuth,
    requireRole("Admin"),
    (req, res) => void handleStatus(req, res)
  );
  app.post(
    "/api/sp/golden-coast/cutover/existing-position-carry-forward",
    privilegedMutationRateLimit,
    requestBudget,
    requireAuth,
    requireRole("Admin"),
    validateRequest(applyCarryForwardInput),
    (req, res) => void handleApply(req, res)
  );
}
