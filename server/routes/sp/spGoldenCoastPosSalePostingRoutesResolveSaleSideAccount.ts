// Extracted from ./spGoldenCoastPosSalePostingRoutes.ts to keep that module under the source-size cap.
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  accountingPostingRequests,
  bankAccounts,
  ledgerAccounts,
  spStockMovements,
  voucherEntries,
  vouchers,
} from "@shared/schema";
import {
  GOLDEN_COAST_POST_CUTOVER_FIFO_SOURCES,
  type GoldenCoastFifoLot,
  goldenCoastPhase5IdempotencyKey,
  type GoldenCoastPhase5PostingRole,
  type GoldenCoastPhase5SaleSideAccount,
  goldenCoastPhase5SourceId,
} from "../../services/accounting/goldenCoastPosSale";
import {
  GoldenCoastPhase5RouteError,
  type DatabaseTransaction,
  type DbLike,
} from "./spGoldenCoastPosSalePostingRoutesActiveSubTypeAccount";

/**
 * Optional caller-selected settlement account. Golden Coast defaults to the
 * canonical GC Sales Cash role; an explicit override must still be a company
 * scoped, active Cash/Bank ledger account or company bank account.
 */
export async function resolveSaleSideAccount(
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
export async function lockFifoLots(
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
export async function findReplayedSale(
  tx: DatabaseTransaction,
  companyId: number,
  requestId: string,
  saleDigest: string
) {
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
