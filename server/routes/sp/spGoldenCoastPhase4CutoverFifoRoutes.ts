import type { Express, NextFunction, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { spStockMovements } from "@shared/schema";
import { requireAuth, requireRole } from "../../auth";
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
  GOLDEN_COAST_CUTOVER_DATE,
  GOLDEN_COAST_CUTOVER_FIFO_SOURCE,
  GoldenCoastPhase4CutoverError,
  buildGoldenCoastCutoverFifoPlan,
  type GoldenCoastInventorySnapshotRow,
} from "../../services/accounting/goldenCoastPhase4CutoverFifo";
import { requireSpCompany } from "./spHelpers";
import { goldenCoastExistingPositionCarryForwardVoucherNumber } from "../../services/accounting/goldenCoastCutoverMarkers";
import { z } from "zod";
import { validateRequest, type RequestSchemas } from "../../lib/validateRequest";
import { spWriteFields } from "./spRequestSchemas";

const phase4RequestBudget = privilegedRequestBudget({ maxBodyBytes: 8 * 1024, maxCollectionItems: 10 });
/**
 * The Phase 3 cutover voucher number is the durable "this company crossed the
 * cutover" marker. Phase 8 reads it too, so both phases agree on one spelling.
 */
export const goldenCoastPhase3VoucherNumber = (companyId: number) => `GC-CUTOVER-20260901-C${companyId}`;
const phase3VoucherNumber = goldenCoastPhase3VoucherNumber;

export type DbLike = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

const RETIRED_GOLDEN_COAST_MUTATIONS: ReadonlyArray<{
  method: "POST" | "PATCH";
  pattern: RegExp;
}> = [
  { method: "POST", pattern: /^\/opening-stock\/?$/ },
  { method: "POST", pattern: /^\/sales\/?$/ },
  { method: "POST", pattern: /^\/sales\/[^/]+\/reverse\/?$/ },
  { method: "POST", pattern: /^\/offload\/?$/ },
  { method: "POST", pattern: /^\/offload\/[^/]+\/reverse\/?$/ },
  { method: "POST", pattern: /^\/prepaid\/?$/ },
  { method: "POST", pattern: /^\/containers\/?$/ },
  { method: "PATCH", pattern: /^\/containers\/[^/]+\/?$/ },
  { method: "POST", pattern: /^\/containers\/[^/]+\/cancel\/?$/ },
];

function isRetiredGoldenCoastMutation(req: Request): boolean {
  if (req.baseUrl !== "/api/sp") return false;
  return RETIRED_GOLDEN_COAST_MUTATIONS.some(({ method, pattern }) => req.method === method && pattern.test(req.path));
}

/**
 * A Golden Coast company is identified by its canonical Phase 2 partner-capital
 * roles, never by name. Phase 5 reuses this guard so both phases agree on which
 * Supplier Partner companies the Golden Coast redesign applies to.
 */
export async function isGoldenCoastCompany(conn: DbLike, companyId: number): Promise<boolean> {
  const rows = await conn.execute(sql`
    SELECT sub_type
    FROM ledger_accounts
    WHERE company_id = ${companyId}
      AND sub_type IN ('gc_partner_capital', 'gc_owner_capital')
      AND active = true
      AND deleted_at IS NULL
  `);
  const found = new Set(resultRows(rows).map((row) => String(row.sub_type)));
  return found.has("gc_partner_capital") && found.has("gc_owner_capital");
}

async function loadSnapshotState(conn: DbLike, companyId: number) {
  const stockRows = await conn.execute(sql`
    SELECT id
    FROM ledger_accounts
    WHERE company_id = ${companyId}
      AND sub_type = 'sp_stock'
      AND active = true
      AND deleted_at IS NULL
    ORDER BY id
    LIMIT 2
  `);
  const stockAccounts = resultRows(stockRows);
  if (stockAccounts.length !== 1) {
    throw new GoldenCoastPhase4CutoverError(
      stockAccounts.length === 0
        ? "Golden Coast Stock in Hand account is not configured"
        : "Golden Coast Stock in Hand account is ambiguous; repair duplicate canonical accounts first"
    );
  }
  const stockAccountId = Number(stockAccounts[0].id);

  const voucherRows = await conn.execute(sql`
    SELECT v.id,
           COALESCE(SUM(CASE WHEN ve.ledger_account_id = ${stockAccountId}
             THEN CAST(ve.debit_amount AS numeric) - CAST(ve.credit_amount AS numeric)
             ELSE 0 END), 0) AS stock_in_hand_opening
    FROM vouchers v
    LEFT JOIN voucher_entries ve ON ve.voucher_id = v.id
    WHERE v.company_id = ${companyId}
      AND v.voucher_number = ${phase3VoucherNumber(companyId)}
      AND v.deleted_at IS NULL
    GROUP BY v.id
    LIMIT 1
  `);
  const voucherRow = resultRows(voucherRows)[0];
  const carryForwardVoucherRows = await conn.execute(sql`
    SELECT v.id,
           COALESCE(SUM(CASE WHEN ve.ledger_account_id = ${stockAccountId}
             THEN CAST(ve.debit_amount AS numeric) - CAST(ve.credit_amount AS numeric)
             ELSE 0 END), 0) AS stock_in_hand_opening
    FROM vouchers v
    LEFT JOIN voucher_entries ve ON ve.voucher_id = v.id
    WHERE v.company_id = ${companyId}
      AND v.voucher_number = ${goldenCoastExistingPositionCarryForwardVoucherNumber(companyId)}
      AND v.deleted_at IS NULL
    GROUP BY v.id
    LIMIT 1
  `);
  const carryForwardVoucherRow = resultRows(carryForwardVoucherRows)[0];
  const openingVoucherRow = voucherRow ?? carryForwardVoucherRow;

  const inventoryRows = await conn.execute(sql`
    SELECT inv.id AS inventory_id,
           inv.location_id,
           inv.stock_item_id,
           inv.quantity,
           inv.average_rate,
           si.code AS article_code,
           si.name AS description
    FROM inventory inv
    INNER JOIN locations loc ON loc.id = inv.location_id AND loc.company_id = ${companyId}
    INNER JOIN stock_items si ON si.id = inv.stock_item_id
    WHERE inv.company_id = ${companyId}
    ORDER BY inv.location_id, inv.stock_item_id
  `);

  const existingRows = await conn.execute(sql`
    SELECT id, stock_item_id, location_id, qty_in, qty_remaining, final_unit_cost_usd
    FROM sp_stock_movements
    WHERE company_id = ${companyId}
      AND source_type = ${GOLDEN_COAST_CUTOVER_FIFO_SOURCE}
    ORDER BY id
  `);
  const existing = resultRows(existingRows);

  const blockers: string[] = [];
  if (!openingVoucherRow) {
    blockers.push(releaseDebtEnglish("Phase 3 cutover voucher has not been posted yet."));
  }
  if (new Date().toISOString().slice(0, 10) < GOLDEN_COAST_CUTOVER_DATE) {
    blockers.push(releaseDebtEnglish(`Opening FIFO cutover cannot be posted before ${GOLDEN_COAST_CUTOVER_DATE}.`));
  }

  let plan: ReturnType<typeof buildGoldenCoastCutoverFifoPlan> | null = null;
  if (openingVoucherRow) {
    try {
      const inventory: GoldenCoastInventorySnapshotRow[] = resultRows(inventoryRows).map((row) => ({
        inventoryId: Number(row.inventory_id),
        locationId: Number(row.location_id),
        stockItemId: Number(row.stock_item_id),
        articleCode: String(row.article_code ?? ""),
        description: row.description == null ? null : String(row.description),
        quantity: String(row.quantity ?? "0"),
        averageRate: String(row.average_rate ?? "0"),
      }));
      plan = buildGoldenCoastCutoverFifoPlan({
        companyId,
        stockInHandOpeningUsd: String(openingVoucherRow.stock_in_hand_opening ?? "0"),
        inventory,
      });
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (existing.length > 0) {
    blockers.push(
      releaseDebtEnglish("Golden Coast cutover FIFO snapshot already exists; rerun is read-only/idempotent.")
    );
  }

  return {
    cutoverDate: GOLDEN_COAST_CUTOVER_DATE,
    phase3VoucherNumber: phase3VoucherNumber(companyId),
    carryForwardVoucherNumber: goldenCoastExistingPositionCarryForwardVoucherNumber(companyId),
    phase3Posted: !!voucherRow,
    carryForwardPosted: !!carryForwardVoucherRow,
    openingPosted: !!openingVoucherRow,
    existing,
    posted: existing.length > 0,
    plan,
    blockers,
    canPost: blockers.length === 0 && !!plan,
  };
}

async function guardLegacyGoldenCoastMutation(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!isRetiredGoldenCoastMutation(req)) {
    next();
    return;
  }

  try {
    const companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    if (!(await isGoldenCoastCompany(db, companyId))) {
      next();
      return;
    }
    res.status(410).json({
      code: "GC_LEGACY_POSTING_RETIRED",
      message: releaseDebtEnglish(
        "This Golden Coast legacy mutation is retired by the September 1 redesign. Legacy records remain readable, but production changes must use the replacement Golden Coast workflow."
      ),
    });
  } catch (error) {
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

async function handleStatus(req: Request, res: Response): Promise<void> {
  try {
    const companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    if (!(await isGoldenCoastCompany(db, companyId))) {
      res.status(409).json({
        code: "GC_PHASE4_NOT_CONFIGURED",
        message: releaseDebtEnglish("Golden Coast account setup is not configured."),
      });
      return;
    }
    res.json(await loadSnapshotState(db, companyId));
  } catch (error) {
    if (error instanceof GoldenCoastPhase4CutoverError) {
      res.status(409).json({ code: "GC_PHASE4_CUTOVER_BLOCKED", message: error.message });
      return;
    }
    logger.error("Golden Coast Phase 4 FIFO status failed", { error });
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

async function handleCutover(req: Request, res: Response): Promise<void> {
  try {
    const companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`golden-coast-phase4-cutover:${companyId}`}))`);
      if (!(await isGoldenCoastCompany(tx, companyId))) {
        throw new GoldenCoastPhase4CutoverError("Golden Coast account setup is not configured");
      }
      const state = await loadSnapshotState(tx, companyId);
      if (state.posted) return { ...state, replayed: true };
      if (!state.canPost || !state.plan) {
        throw new GoldenCoastPhase4CutoverError(state.blockers.join(" ") || "Cutover FIFO is not ready");
      }
      const inserted = [];
      for (const movement of state.plan.movements) {
        const [row] = await tx.insert(spStockMovements).values(movement).returning();
        inserted.push(row);
      }
      return { ...(await loadSnapshotState(tx, companyId)), inserted, replayed: false };
    });
    res.json(result);
  } catch (error) {
    if (error instanceof GoldenCoastPhase4CutoverError) {
      res.status(409).json({ code: "GC_PHASE4_CUTOVER_BLOCKED", message: error.message });
      return;
    }
    logger.error("Golden Coast Phase 4 FIFO cutover failed", { error });
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

// handleCutover reads no body field; the access-control fields are for the SP guard.
const phase4CutoverFifoInput = { body: z.strictObject(spWriteFields) } satisfies RequestSchemas;

export function registerSpGoldenCoastPhase4CutoverFifoRoutes(app: Express): void {
  // The SP access-control middleware is registered before this module. Intercept the
  // exact superseded Golden Coast mutation shapes without registering shadow routes,
  // so non-Golden-Coast Supplier Partner companies retain their existing handlers.
  app.use("/api/sp", (req, res, next) => void guardLegacyGoldenCoastMutation(req, res, next));

  app.get(
    "/api/sp/golden-coast/phase4/cutover-fifo/status",
    privilegedReadRateLimit,
    requireAuth,
    requireRole("Admin"),
    (req, res) => void handleStatus(req, res)
  );
  // `cutover` activates SP migration confirmation, reason and idempotency-key enforcement.
  app.post(
    "/api/sp/golden-coast/phase4/cutover-fifo",
    privilegedMutationRateLimit,
    phase4RequestBudget,
    requireAuth,
    requireRole("Admin"),
    validateRequest(phase4CutoverFifoInput),
    (req, res) => void handleCutover(req, res)
  );
}
