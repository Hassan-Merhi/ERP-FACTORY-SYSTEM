// ── Golden Coast Phase 5: production POS sale posting ────────────────────────
//
// Phase 4 retired the legacy Supplier Partner `/api/sp/sales` mutation and the
// Phase 1 `location_sale` posting for Golden Coast companies. This module is
// their post-cutover replacement: it consumes the canonical Phase 4 FIFO lots,
// derives COGS from the units actually consumed, and posts Sales and COGS
// through the existing central posting engine inside one transaction that also
// owns the inventory movement.
//
// Non-Golden-Coast Supplier Partner companies never reach this handler: the
// readiness guard rejects them and their existing `/api/sp/sales` flow is left
// exactly as it was.

import type { Express, Request, Response } from "express";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  accountingPostingRequests,
  bankAccounts,
  ledgerAccounts,
  locations,
  spStockMovements,
  voucherEntries,
  vouchers,
} from "@shared/schema";
import { requireAuth } from "../../auth";
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
  type CentralPostingResult,
} from "../../services/accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../../services/accounting/databasePostingDependencies";
import {
  getGoldenCoastAccountDefinition,
  type GoldenCoastAccountRole,
  type GoldenCoastLedgerRow,
} from "../../services/accounting/goldenCoastAccounts";
import {
  GOLDEN_COAST_CUTOVER_FIFO_SOURCE,
  GOLDEN_COAST_CUTOVER_DATE,
} from "../../services/accounting/goldenCoastCutoverFifo";
import {
  GOLDEN_COAST_POST_CUTOVER_FIFO_SOURCES,
  GoldenCoastPhase5SaleError,
  buildGoldenCoastPhase5SalePostings,
  goldenCoastPhase5IdempotencyKey,
  goldenCoastPhase5SaleDigest,
  goldenCoastPhase5SourceId,
  parseGoldenCoastPhase5SaleInput,
  planGoldenCoastPhase5Sale,
  type GoldenCoastFifoLot,
  type GoldenCoastPhase5PostingRole,
  type GoldenCoastPhase5RoleAccounts,
  type GoldenCoastPhase5SaleSideAccount,
  type GoldenCoastPhase5SaleInput,
} from "../../services/accounting/goldenCoastPosSale";
import { adjustSpInventoryAtomic, respondToSpInventoryIntegrityError } from "../../services/sp/spInventoryIntegrity";
import { isGoldenCoastCompany } from "./spGoldenCoastCutoverFifoRoutes";
import { loadGoldenCoastAccounts } from "./spGoldenCoastSetupRoutes";
import { requireSpCompany } from "./spHelpers";
import { getCurrentExchangeRate } from "../helpers/exchangeRateHelpers";

const postingDependencies = createDatabasePostingDependencies();
const phase5RequestBudget = privilegedRequestBudget({ maxBodyBytes: 32 * 1024, maxCollectionItems: 50 });
const PHASE5_MAX_SALE_LINES = 50;

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbLike = typeof db | DatabaseTransaction;
type PersistedPostingResult = CentralPostingResult<typeof vouchers.$inferSelect, typeof voucherEntries.$inferSelect>;

class GoldenCoastPhase5RouteError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = "GC_PHASE5_SALE_INVALID", status = 400) {
    super(releaseDebtEnglish(message));
    this.name = "GoldenCoastPhase5RouteError";
    this.code = code;
    this.status = status;
  }
}

/** Canonical Phase 2 roles the Phase 5 journal posts against. */
const PHASE5_REQUIRED_ROLES = ["gc_sales_cash", "stock_in_hand"] as const satisfies readonly GoldenCoastAccountRole[];

/** Sales/COGS keep their canonical Supplier Partner sub types. */
const SALES_REVENUE_SUBTYPE = "sp_sales";
const COGS_SUBTYPE = "sp_cogs";

function activeCanonicalRoleAccount(
  accounts: readonly GoldenCoastLedgerRow[],
  role: GoldenCoastAccountRole
): GoldenCoastLedgerRow {
  const definition = getGoldenCoastAccountDefinition(role);
  const matches = accounts.filter(
    (account) => account.subType === definition.subType && account.active === true && account.deletedAt == null
  );
  if (matches.length !== 1) {
    throw new GoldenCoastPhase5RouteError(
      matches.length === 0
        ? `Golden Coast role ${role} is missing; run Golden Coast account setup first`
        : `Golden Coast role ${role} is ambiguous (${matches.length} active accounts share ${definition.subType})`,
      "GC_PHASE5_ROLES_INVALID",
      409
    );
  }
  return matches[0];
}

async function activeSubTypeAccount(
  conn: DbLike,
  companyId: number,
  subType: string,
  expectedAccountTypes: readonly string[]
): Promise<{ id: number; name: string; accountType: string }> {
  const rows = await conn
    .select({ id: ledgerAccounts.id, name: ledgerAccounts.name, accountType: ledgerAccounts.accountType })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.subType, subType),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .orderBy(asc(ledgerAccounts.id))
    .limit(2);

  if (rows.length !== 1) {
    throw new GoldenCoastPhase5RouteError(
      rows.length === 0
        ? `Golden Coast accounting role ${subType} is not configured for this company`
        : `Golden Coast accounting role ${subType} is ambiguous; repair duplicate canonical accounts first`,
      "GC_PHASE5_ROLES_INVALID",
      409
    );
  }
  const account = { id: Number(rows[0].id), name: rows[0].name, accountType: String(rows[0].accountType) };
  if (!expectedAccountTypes.includes(account.accountType)) {
    throw new GoldenCoastPhase5RouteError(
      `Golden Coast accounting role ${subType} must be one of ${expectedAccountTypes.join(", ")}; ` +
        `account "${account.name}" is ${account.accountType}`,
      "GC_PHASE5_ROLES_INVALID",
      409
    );
  }
  return account;
}

async function resolvePhase5Accounts(
  conn: DbLike,
  companyId: number
): Promise<GoldenCoastPhase5RoleAccounts & { saleSideAccountName: string }> {
  const goldenCoastAccounts = await loadGoldenCoastAccounts(conn, companyId);
  for (const role of PHASE5_REQUIRED_ROLES) activeCanonicalRoleAccount(goldenCoastAccounts, role);

  const saleSide = activeCanonicalRoleAccount(goldenCoastAccounts, "gc_sales_cash");
  const stockInHand = activeCanonicalRoleAccount(goldenCoastAccounts, "stock_in_hand");
  const [salesRevenue, cogs] = await Promise.all([
    activeSubTypeAccount(conn, companyId, SALES_REVENUE_SUBTYPE, ["Income", "Direct Income"]),
    activeSubTypeAccount(conn, companyId, COGS_SUBTYPE, ["Direct Expense", "Expense"]),
  ]);

  return {
    saleSideAccountId: saleSide.id,
    saleSideAccountName: saleSide.name,
    salesRevenueAccountId: salesRevenue.id,
    cogsAccountId: cogs.id,
    stockInHandAccountId: stockInHand.id,
  };
}

/**
 * Phase 5 only runs on a company whose Phase 3 cutover and Phase 4 opening FIFO
 * bridge are already in place: without them a sale would consume lots that have
 * no reconciled acquisition cost behind them.
 */
async function assertPhase4BridgePosted(conn: DbLike, companyId: number): Promise<number> {
  const rows = await conn.execute(sql`
    SELECT COUNT(*)::int AS lot_count
    FROM sp_stock_movements
    WHERE company_id = ${companyId}
      AND source_type = ${GOLDEN_COAST_CUTOVER_FIFO_SOURCE}
  `);
  const lotCount = Number(resultRows(rows)[0]?.lot_count ?? 0);
  if (lotCount <= 0) {
    throw new GoldenCoastPhase5RouteError(
      `The Golden Coast ${GOLDEN_COAST_CUTOVER_DATE} opening FIFO bridge has not been posted yet`,
      "GC_PHASE5_NOT_READY",
      409
    );
  }
  return lotCount;
}

async function assertCompanyLocation(conn: DbLike, companyId: number, locationId: number): Promise<void> {
  const [row] = await conn
    .select({ id: locations.id })
    .from(locations)
    .where(
      and(
        eq(locations.id, locationId),
        eq(locations.companyId, companyId),
        eq(locations.active, true),
        isNull(locations.deletedAt)
      )
    )
    .limit(1);
  if (!row) {
    throw new GoldenCoastPhase5RouteError(
      `Location ${locationId} is not an active location in this company`,
      "GC_PHASE5_LOCATION_INVALID",
      400
    );
  }
}

/**
 * Optional caller-selected settlement account. Golden Coast defaults to the
 * canonical GC Sales Cash role; an explicit override must still be a company
 * scoped, active Cash/Bank ledger account or company bank account.
 */
async function resolveSaleSideAccount(
  conn: DbLike,
  companyId: number,
  raw: unknown,
  fallbackLedgerAccountId: number
): Promise<GoldenCoastPhase5SaleSideAccount> {
  if (raw == null) return { kind: "ledger", id: fallbackLedgerAccountId };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new GoldenCoastPhase5RouteError("saleSideAccount must be an object when supplied");
  }
  const input = raw as Record<string, unknown>;
  if (input.kind !== "ledger" && input.kind !== "bank") {
    throw new GoldenCoastPhase5RouteError('saleSideAccount.kind must be "ledger" or "bank"');
  }
  const id = Number(input.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new GoldenCoastPhase5RouteError("saleSideAccount.id must be a positive integer");
  }

  if (input.kind === "bank") {
    const [row] = await conn
      .select({ id: bankAccounts.id })
      .from(bankAccounts)
      .where(
        and(
          eq(bankAccounts.id, id),
          eq(bankAccounts.companyId, companyId),
          eq(bankAccounts.active, true),
          isNull(bankAccounts.deletedAt)
        )
      )
      .limit(1);
    if (!row) {
      throw new GoldenCoastPhase5RouteError("saleSideAccount must reference an active bank account in this company");
    }
    return { kind: "bank", id };
  }

  if (id === fallbackLedgerAccountId) return { kind: "ledger", id };

  const [row] = await conn
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.id, id),
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt),
        inArray(ledgerAccounts.accountType, ["Cash", "Bank"])
      )
    )
    .limit(1);
  if (!row) {
    throw new GoldenCoastPhase5RouteError(
      "saleSideAccount must reference the Golden Coast sale-side role or an active Cash/Bank ledger account in this company"
    );
  }
  return { kind: "ledger", id };
}

/**
 * Locks and returns every post-cutover FIFO lot that can back this sale, in
 * canonical FIFO order. The lots are company, location and stock-item scoped,
 * and `FOR UPDATE` keeps two concurrent sales from consuming the same units.
 */
async function lockFifoLots(
  tx: DatabaseTransaction,
  companyId: number,
  locationId: number,
  stockItemIds: readonly number[]
): Promise<GoldenCoastFifoLot[]> {
  const rows = await tx
    .select({
      id: spStockMovements.id,
      companyId: spStockMovements.companyId,
      locationId: spStockMovements.locationId,
      stockItemId: spStockMovements.stockItemId,
      articleCode: spStockMovements.articleCode,
      description: spStockMovements.description,
      sourceType: spStockMovements.sourceType,
      qtyRemaining: spStockMovements.qtyRemaining,
      finalUnitCostUsd: spStockMovements.finalUnitCostUsd,
      createdAt: spStockMovements.createdAt,
    })
    .from(spStockMovements)
    .where(
      and(
        eq(spStockMovements.companyId, companyId),
        eq(spStockMovements.locationId, locationId),
        inArray(spStockMovements.stockItemId, [...stockItemIds]),
        // Legacy pre-cutover movement rows survive the Phase 4 bridge and sort
        // first by created_at, so consuming them would both double the
        // available quantity and cost the sale at unreconciled pre-cutover
        // rates. Only canonical post-cutover lots back a Golden Coast sale.
        inArray(spStockMovements.sourceType, [...GOLDEN_COAST_POST_CUTOVER_FIFO_SOURCES]),
        sql`CAST(${spStockMovements.qtyRemaining} AS numeric) > 0`
      )
    )
    .orderBy(asc(spStockMovements.createdAt), asc(spStockMovements.id))
    .for("update");

  return rows.map((row) => ({
    id: Number(row.id),
    companyId: Number(row.companyId),
    locationId: row.locationId == null ? null : Number(row.locationId),
    stockItemId: row.stockItemId == null ? null : Number(row.stockItemId),
    articleCode: String(row.articleCode ?? ""),
    description: row.description == null ? null : String(row.description),
    sourceType: row.sourceType == null ? null : String(row.sourceType),
    qtyRemaining: String(row.qtyRemaining ?? "0"),
    finalUnitCostUsd: String(row.finalUnitCostUsd ?? "0"),
    createdAt: row.createdAt == null ? null : new Date(row.createdAt).toISOString(),
  }));
}

async function findPostedVoucher(
  tx: DatabaseTransaction,
  companyId: number,
  idempotencyKey: string
): Promise<{ voucher: typeof vouchers.$inferSelect; sourceId: string } | null> {
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

  const [voucher] = await tx
    .select()
    .from(vouchers)
    .where(and(eq(vouchers.id, Number(marker.voucherId)), eq(vouchers.companyId, companyId)))
    .limit(1);
  if (!voucher) {
    throw new GoldenCoastPhase5RouteError(
      `Golden Coast sale idempotency marker ${idempotencyKey} references a missing voucher`,
      "GC_PHASE5_IDEMPOTENCY_INCONSISTENT",
      409
    );
  }
  return { voucher, sourceId: String(marker.sourceId ?? "") };
}

async function loadVoucherEntries(tx: DatabaseTransaction, voucherId: number) {
  return tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, voucherId));
}

/**
 * Replay detection. Both Phase 5 vouchers share one client request id, so a
 * replay is only safe when *both* markers exist; a half-recorded pair means the
 * idempotency state is inconsistent and the sale must not post again.
 *
 * A replay is also only safe when the request describes the *same* sale. The
 * outer voucher-path boundary keys on transport identity, so a caller can reuse
 * a client request id with changed sale data behind a fresh transport key. The
 * stored sourceId carries the original payload digest, so that request is
 * rejected here rather than being answered with the earlier sale's vouchers.
 */
async function findReplayedSale(tx: DatabaseTransaction, companyId: number, requestId: string, saleDigest: string) {
  const roles: GoldenCoastPhase5PostingRole[] = ["revenue", "cogs"];
  const found = await Promise.all(
    roles.map(async (role) => ({
      role,
      marker: await findPostedVoucher(tx, companyId, goldenCoastPhase5IdempotencyKey(companyId, requestId, role)),
    }))
  );

  const posted = found.filter((item) => item.marker != null);
  if (posted.length === 0) return null;
  if (posted.length !== roles.length) {
    throw new GoldenCoastPhase5RouteError(
      `Golden Coast sale ${requestId} has a partially recorded posting pair and cannot be replayed safely`,
      "GC_PHASE5_IDEMPOTENCY_INCONSISTENT",
      409
    );
  }

  for (const item of found) {
    const expectedSourceId = goldenCoastPhase5SourceId(requestId, saleDigest, item.role);
    if (item.marker?.sourceId !== expectedSourceId) {
      throw new GoldenCoastPhase5RouteError(
        `Golden Coast sale ${requestId} was already posted with different sale data; ` +
          `use a new clientRequestId for a different sale`,
        "GC_PHASE5_IDEMPOTENCY_CONFLICT",
        409
      );
    }
  }

  return Promise.all(
    found.map(async (item) => {
      const voucher = (item.marker as { voucher: typeof vouchers.$inferSelect }).voucher;
      return { role: item.role, voucher, entries: await loadVoucherEntries(tx, voucher.id) };
    })
  );
}

async function consumeFifoLot(
  tx: DatabaseTransaction,
  companyId: number,
  allocation: { lotId: number; qty: string; qtyRemainingAfter: string }
): Promise<void> {
  const updated = await tx.execute(sql`
    UPDATE sp_stock_movements
    SET qty_remaining = ${allocation.qtyRemainingAfter}
    WHERE id = ${allocation.lotId}
      AND company_id = ${companyId}
      AND CAST(qty_remaining AS numeric) >= CAST(${allocation.qty} AS numeric)
    RETURNING id
  `);
  if (resultRows(updated).length !== 1) {
    throw new GoldenCoastPhase5RouteError(
      `Golden Coast FIFO lot #${allocation.lotId} changed while the sale was being posted`,
      "GC_PHASE5_FIFO_CONFLICT",
      409
    );
  }
}

async function handleReadiness(req: Request, res: Response): Promise<void> {
  try {
    const companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    if (!(await isGoldenCoastCompany(db, companyId))) {
      res.status(409).json({
        code: "GC_PHASE5_NOT_CONFIGURED",
        message: releaseDebtEnglish("Golden Coast account setup is not configured."),
      });
      return;
    }

    const blockers: string[] = [];
    let accounts: Awaited<ReturnType<typeof resolvePhase5Accounts>> | null = null;
    let cutoverLotCount = 0;
    try {
      accounts = await resolvePhase5Accounts(db, companyId);
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
    }
    try {
      cutoverLotCount = await assertPhase4BridgePosted(db, companyId);
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
    }

    const available = await db
      .select({
        locationId: spStockMovements.locationId,
        stockItemId: spStockMovements.stockItemId,
        articleCode: spStockMovements.articleCode,
        qtyAvailable: sql<string>`COALESCE(SUM(CAST(${spStockMovements.qtyRemaining} AS numeric)), 0)::text`,
      })
      .from(spStockMovements)
      .where(
        and(
          eq(spStockMovements.companyId, companyId),
          inArray(spStockMovements.sourceType, [...GOLDEN_COAST_POST_CUTOVER_FIFO_SOURCES]),
          sql`CAST(${spStockMovements.qtyRemaining} AS numeric) > 0`
        )
      )
      .groupBy(spStockMovements.locationId, spStockMovements.stockItemId, spStockMovements.articleCode)
      .orderBy(asc(spStockMovements.locationId), asc(spStockMovements.stockItemId));

    res.json({
      cutoverDate: GOLDEN_COAST_CUTOVER_DATE,
      cutoverLotCount,
      accounts,
      availableStock: available,
      blockers,
      canPost: blockers.length === 0,
    });
  } catch (error) {
    logger.error("Golden Coast Phase 5 readiness failed", { error });
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

async function handlePostSale(req: Request, res: Response): Promise<void> {
  const startedAt = Date.now();
  let companyId: number | null = null;
  const userId = req.session.userId;

  try {
    companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    const selectedCompany = companyId;

    if (!(await isGoldenCoastCompany(db, selectedCompany))) {
      res.status(409).json({
        code: "GC_PHASE5_NOT_CONFIGURED",
        message: releaseDebtEnglish("Golden Coast account setup is not configured."),
      });
      return;
    }

    const sale: GoldenCoastPhase5SaleInput = parseGoldenCoastPhase5SaleInput({
      companyId: selectedCompany,
      body: req.body,
      maxLines: PHASE5_MAX_SALE_LINES,
    });
    const exchangeRate = await getCurrentExchangeRate(selectedCompany);

    const result = await db.transaction(async (tx) => {
      // Serializes two concurrent submissions of the same sale so replay
      // detection, FIFO consumption and both postings observe one state.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`golden-coast-phase5-sale:${selectedCompany}:${sale.clientRequestId}`}))`
      );

      if (!(await isGoldenCoastCompany(tx, selectedCompany))) {
        throw new GoldenCoastPhase5RouteError(
          "Golden Coast account setup is not configured",
          "GC_PHASE5_NOT_CONFIGURED",
          409
        );
      }

      await assertPhase4BridgePosted(tx, selectedCompany);
      await assertCompanyLocation(tx, selectedCompany, sale.locationId);
      const accounts = await resolvePhase5Accounts(tx, selectedCompany);
      const saleSideAccount = await resolveSaleSideAccount(
        tx,
        selectedCompany,
        (req.body as Record<string, unknown> | undefined)?.saleSideAccount,
        accounts.saleSideAccountId
      );

      // Resolved before replay detection because the settlement account is part
      // of what makes two submissions the same sale.
      const saleDigest = goldenCoastPhase5SaleDigest({ sale, saleSideAccount });
      const replayed = await findReplayedSale(tx, selectedCompany, sale.clientRequestId, saleDigest);
      if (replayed) return { replayed: true as const, postings: replayed, plan: null };

      const stockItemIds = [...new Set(sale.lines.map((line) => line.stockItemId))];
      const lots = await lockFifoLots(tx, selectedCompany, sale.locationId, stockItemIds);
      const plan = planGoldenCoastPhase5Sale({ sale, lots });

      for (const allocation of plan.allocations) {
        await consumeFifoLot(tx, selectedCompany, allocation);
        await adjustSpInventoryAtomic(tx, {
          companyId: selectedCompany,
          locationId: allocation.locationId,
          stockItemId: allocation.stockItemId,
          deltaQty: -Number(allocation.qty),
          context: `Golden Coast Phase 5 sale ${sale.clientRequestId} from FIFO lot #${allocation.lotId}`,
          sourceVoucherType: "GC_PHASE5_SALE",
        });
      }

      const batch = buildGoldenCoastPhase5SalePostings({
        plan,
        accounts,
        saleSideAccount,
        saleDigest,
        exchangeRate: exchangeRate != null ? String(exchangeRate) : null,
        actor: {
          userId: userId ?? null,
          username: req.session.username || "unknown",
          reason: "Golden Coast Phase 5 POS sale",
        },
      });

      const postings: Array<{
        role: GoldenCoastPhase5PostingRole;
        voucher: PersistedPostingResult["voucher"];
        entries: PersistedPostingResult["entries"];
      }> = [];
      for (const item of batch.postings) {
        const posted = (await postBalancedVoucherTx(tx, item.request, postingDependencies)) as PersistedPostingResult;
        if (posted.replayed) {
          // Replay detection above found no markers, so a replay here means the
          // idempotency state moved underneath this transaction.
          throw new GoldenCoastPhase5RouteError(
            `Golden Coast sale ${sale.clientRequestId} ${item.role} voucher was already posted`,
            "GC_PHASE5_IDEMPOTENCY_INCONSISTENT",
            409
          );
        }
        postings.push({ role: item.role, voucher: posted.voucher, entries: posted.entries });
      }

      return { replayed: false as const, postings, plan };
    });

    logger.info("Golden Coast Phase 5 POS sale posted", {
      module: "golden-coast-phase5",
      companyId: selectedCompany,
      userId,
      clientRequestId: sale.clientRequestId,
      locationId: sale.locationId,
      replayed: result.replayed,
      voucherIds: result.postings.map((item) => item.voucher.id),
      durationMs: Date.now() - startedAt,
    });

    res.json({
      clientRequestId: sale.clientRequestId,
      locationId: sale.locationId,
      replayed: result.replayed,
      revenueUsd: result.plan?.revenueUsd ?? null,
      cogsUsd: result.plan?.cogsUsd ?? null,
      grossProfitUsd: result.plan?.grossProfitUsd ?? null,
      lines: result.plan?.lines ?? null,
      allocations: result.plan?.allocations ?? null,
      postings: result.postings.map((item) => ({
        role: item.role,
        voucher: item.voucher,
        entries: item.entries,
      })),
    });
  } catch (error: unknown) {
    logger.error("Golden Coast Phase 5 POS sale failed", {
      module: "golden-coast-phase5",
      companyId,
      userId,
      durationMs: Date.now() - startedAt,
      error,
    });

    if (error instanceof GoldenCoastPhase5RouteError) {
      res.status(error.status).json({ code: error.code, message: error.message });
      return;
    }
    if (error instanceof GoldenCoastPhase5SaleError) {
      const status = error.code === "GC_PHASE5_INPUT_INVALID" ? 400 : 409;
      res.status(status).json({ code: error.code, message: error.message });
      return;
    }
    if (respondToSpInventoryIntegrityError(res, error)) return;
    if (error instanceof PostingValidationError) {
      res.status(error.code === "POSTING_IDEMPOTENCY_CORRUPT" ? 409 : 400).json({
        code: error.code,
        message: error.message,
      });
      return;
    }
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

export function registerSpGoldenCoastPhase5PosSaleRoutes(app: Express): void {
  app.get(
    "/api/sp/golden-coast/phase5/pos-sale/readiness",
    privilegedReadRateLimit,
    requireAuth,
    (req, res) => void handleReadiness(req, res)
  );
  // Company scope, Supplier Partner permission (`sp_sales_create`) and audit
  // logging are enforced by the SP access-control middleware mounted earlier.
  app.post(
    "/api/sp/golden-coast/phase5/pos-sale",
    privilegedMutationRateLimit,
    phase5RequestBudget,
    requireAuth,
    (req, res) => void handlePostSale(req, res)
  );
}
