import { eq, and, sql, isNull } from "drizzle-orm";
import Decimal from "decimal.js";
import {
  factorySuppliers,
  factoryRawStock,
  factoryContainers,
  factoryRawMaterialAdjustments,
  factoryMixBatchSources,
  factoryMixBatches,
} from "@shared/schema";
import { getStableSupplierCost } from "./rawStockStableCost";
import { db as sharedDb } from "../../db";
import { FACTORY_HISTORICAL_REPLAY_V7_SCHEMA_SQL } from "./historicalReplayV7MigrationSql";
import { calculateCostLine, calculateMovingAverageRate, formatFactoryLockedRate } from "./factoryCostingEngine";
import type { DatabaseOrTransaction } from "../../db";

/**
 * Authoritative supplier raw-material quantity. This is the same quantity shown by
 * the Raw Materials API and used by the moving-average offload formula.
 */
export async function getAuthoritativeSupplierRemainingKg(
  tx: DatabaseOrTransaction,
  companyId: number,
  supplierId: number
): Promise<number> {
  const [{ remainingKg }] = await tx
    .select({
      remainingKg: sql<string>`COALESCE(SUM(${factoryRawStock.receivedKg} - ${factoryRawStock.usedKg}), 0)`,
    })
    .from(factoryRawStock)
    .innerJoin(factoryContainers, eq(factoryRawStock.containerId, factoryContainers.id))
    .where(
      and(
        eq(factoryRawStock.companyId, companyId),
        eq(factoryContainers.supplierId, supplierId),
        sql`${factoryContainers.status} != 'DELETED'`,
        sql`${factoryRawStock.deletedAt} IS NULL`,
        sql`${factoryContainers.deletedAt} IS NULL`
      )
    );

  const [{ netAdjustedKg }] = await tx
    .select({
      netAdjustedKg: sql<string>`COALESCE(SUM(CASE WHEN ${factoryRawMaterialAdjustments.type} = 'ADD' THEN ${factoryRawMaterialAdjustments.kg} WHEN ${factoryRawMaterialAdjustments.type} = 'REMOVE' THEN -${factoryRawMaterialAdjustments.kg} ELSE 0 END), 0)`,
    })
    .from(factoryRawMaterialAdjustments)
    .where(
      and(
        eq(factoryRawMaterialAdjustments.companyId, companyId),
        eq(factoryRawMaterialAdjustments.supplierId, supplierId),
        sql`${factoryRawMaterialAdjustments.deletedAt} IS NULL`
      )
    );

  return new Decimal(remainingKg || 0).plus(netAdjustedKg || 0).toNumber();
}

type RawSqlExecutor = {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
};

/** Executor-aware quantity helper used inside the serializable replay transaction. */
export async function getAuthoritativeSupplierRemainingKgWithExecutor(
  executor: RawSqlExecutor,
  companyId: number,
  supplierId: number
): Promise<number> {
  const [stockResult, adjustmentResult] = await Promise.all([
    executor.query(
      `SELECT COALESCE(SUM(frs.received_kg - frs.used_kg), 0) AS remaining_kg
       FROM factory_raw_stock frs
       JOIN factory_containers fc ON fc.id = frs.container_id
       WHERE frs.company_id = $1
         AND fc.supplier_id = $2
         AND fc.status != 'DELETED'
         AND frs.deleted_at IS NULL
         AND fc.deleted_at IS NULL`,
      [companyId, supplierId]
    ),
    executor.query(
      `SELECT COALESCE(SUM(
               CASE WHEN type = 'ADD' THEN kg
                    WHEN type = 'REMOVE' THEN -kg
                    ELSE 0
               END
             ), 0) AS net_adjusted_kg
       FROM factory_raw_material_adjustments
       WHERE company_id = $1
         AND supplier_id = $2
         AND deleted_at IS NULL`,
      [companyId, supplierId]
    ),
  ]);

  return new Decimal(String(stockResult.rows[0]?.remaining_kg ?? 0))
    .plus(String(adjustmentResult.rows[0]?.net_adjusted_kg ?? 0))
    .toNumber();
}

/**
 * Read the persisted locked supplier rate. A legacy NULL value is derived once from
 * the stable historical receipt cost and persisted; subsequent reads remain stable.
 */
export async function getLockedSupplierRate(
  tx: DatabaseOrTransaction,
  companyId: number,
  supplierId: number,
  opts: { forUpdate?: boolean } = {}
): Promise<number> {
  const query = tx
    .select({
      id: factorySuppliers.id,
      currentRawMaterialCostPerKgUsd: factorySuppliers.currentRawMaterialCostPerKgUsd,
    })
    .from(factorySuppliers)
    .where(and(eq(factorySuppliers.id, supplierId), eq(factorySuppliers.companyId, companyId)));

  const [supplier] = await (opts.forUpdate ? query.for("update") : query);
  if (!supplier) return 0;

  const existing = supplier.currentRawMaterialCostPerKgUsd;
  if (existing !== null && existing !== undefined) {
    return new Decimal(existing || 0).toNumber();
  }

  const { costPerKgUsd } = await getStableSupplierCost(tx, companyId, supplierId);
  if (costPerKgUsd > 0) {
    await tx
      .update(factorySuppliers)
      .set({ currentRawMaterialCostPerKgUsd: formatFactoryLockedRate(costPerKgUsd) })
      .where(and(eq(factorySuppliers.id, supplierId), eq(factorySuppliers.companyId, companyId)));
  }
  return costPerKgUsd;
}

/** Pure read-only variant: never performs the legacy lazy-backfill write. */
export async function getLockedSupplierRateReadOnly(
  tx: DatabaseOrTransaction,
  companyId: number,
  supplierId: number
): Promise<{ rate: number; wasBackfilled: boolean }> {
  const [supplier] = await tx
    .select({ currentRawMaterialCostPerKgUsd: factorySuppliers.currentRawMaterialCostPerKgUsd })
    .from(factorySuppliers)
    .where(and(eq(factorySuppliers.id, supplierId), eq(factorySuppliers.companyId, companyId)));
  if (!supplier) return { rate: 0, wasBackfilled: false };

  const existing = supplier.currentRawMaterialCostPerKgUsd;
  if (existing !== null && existing !== undefined) {
    return { rate: new Decimal(existing || 0).toNumber(), wasBackfilled: false };
  }

  const { costPerKgUsd } = await getStableSupplierCost(tx, companyId, supplierId);
  return { rate: costPerKgUsd, wasBackfilled: false };
}

export interface LockedRateDiagnosticRow {
  companyId: number;
  supplierId: number;
  supplierName: string;
  persistedLockedRate: number | null;
  rawMaterialsDisplayedRate: number;
  mixBatchDialogRate: number;
  remainingKg: number;
  reservedKg: number;
  freeKg: number;
  displayedValue: string;
  expectedValue: string;
  difference: string;
  backfillRequired: boolean;
}

/** Shared read-only locked-rate reconciliation used by diagnostics and UI. */
export async function getLockedRateDiagnosticsForCompany(companyId: number): Promise<LockedRateDiagnosticRow[]> {
  const db = sharedDb;
  const suppliers = await db
    .select({
      id: factorySuppliers.id,
      name: factorySuppliers.name,
      currentRawMaterialCostPerKgUsd: factorySuppliers.currentRawMaterialCostPerKgUsd,
    })
    .from(factorySuppliers)
    .where(eq(factorySuppliers.companyId, companyId));

  const reservedRows = await db
    .select({
      supplierId: factoryMixBatchSources.supplierId,
      reservedKg: sql<string>`SUM(${factoryMixBatchSources.weightKg})`,
    })
    .from(factoryMixBatchSources)
    .innerJoin(factoryMixBatches, eq(factoryMixBatchSources.mixBatchId, factoryMixBatches.id))
    .where(
      and(
        eq(factoryMixBatches.companyId, companyId),
        sql`${factoryMixBatchSources.supplierId} IS NOT NULL`,
        sql`${factoryMixBatches.status} NOT IN ('CLOSED', 'COMPLETED')`,
        isNull(factoryMixBatches.deletedAt)
      )
    )
    .groupBy(factoryMixBatchSources.supplierId);

  const reservedBySupplierId = new Map<number, number>();
  for (const row of reservedRows) {
    if (row.supplierId) {
      reservedBySupplierId.set(row.supplierId, parseFloat(row.reservedKg as string) || 0);
    }
  }

  return db.transaction(async (tx) => {
    const rows: LockedRateDiagnosticRow[] = [];
    for (const supplier of suppliers) {
      const persistedRaw = supplier.currentRawMaterialCostPerKgUsd;
      const persistedLockedRate =
        persistedRaw !== null && persistedRaw !== undefined ? parseFloat(persistedRaw as string) || 0 : null;
      const { rate } = await getLockedSupplierRateReadOnly(tx, companyId, supplier.id);
      const remainingKg = await getAuthoritativeSupplierRemainingKg(tx, companyId, supplier.id);
      const reservedKg = reservedBySupplierId.get(supplier.id) || 0;
      const displayedValue = calculateCostLine(remainingKg, rate).totalCost;
      const expectedValue = calculateCostLine(remainingKg, persistedLockedRate ?? 0).totalCost;

      rows.push({
        companyId,
        supplierId: supplier.id,
        supplierName: supplier.name,
        persistedLockedRate,
        rawMaterialsDisplayedRate: rate,
        mixBatchDialogRate: rate,
        remainingKg,
        reservedKg,
        freeKg: remainingKg,
        displayedValue: displayedValue.toFixed(2),
        expectedValue: expectedValue.toFixed(2),
        difference: displayedValue.minus(expectedValue).toFixed(2),
        backfillRequired: persistedLockedRate === null,
      });
    }
    return rows;
  });
}

/**
 * Apply the remaining-stock moving average immediately before inserting a new
 * supplier receipt. Fully consumed historical stock never re-enters the average.
 */
export async function applyOffloadMovingAverage(
  tx: DatabaseOrTransaction,
  params: {
    companyId: number;
    supplierId: number;
    newReceivedKg: number;
    newContainerLandedCostPerKgUsd: number;
  }
): Promise<{ oldRemainingKg: number; oldLockedRate: number; newLockedRate: number }> {
  const { companyId, supplierId, newReceivedKg, newContainerLandedCostPerKgUsd } = params;
  const oldLockedRate = await getLockedSupplierRate(tx, companyId, supplierId, {
    forUpdate: true,
  });
  const oldRemainingKg = Math.max(0, await getAuthoritativeSupplierRemainingKg(tx, companyId, supplierId));
  const newLockedRate = calculateMovingAverageRate({
    existingQuantityKg: oldRemainingKg,
    existingRatePerKg: oldLockedRate,
    incomingQuantityKg: newReceivedKg,
    incomingRatePerKg: newContainerLandedCostPerKgUsd,
  });

  await tx
    .update(factorySuppliers)
    .set({
      currentRawMaterialCostPerKgUsd: formatFactoryLockedRate(newLockedRate),
      updatedAt: new Date(),
    })
    .where(and(eq(factorySuppliers.id, supplierId), eq(factorySuppliers.companyId, companyId)));

  return { oldRemainingKg, oldLockedRate, newLockedRate: newLockedRate.toNumber() };
}

/** Quantity-only manual ADDs require an already-established locked rate. */
export async function requireExistingLockedRate(
  tx: DatabaseOrTransaction,
  companyId: number,
  supplierId: number
): Promise<number | null> {
  const rate = await getLockedSupplierRate(tx, companyId, supplierId, { forUpdate: true });
  return rate > 0 ? rate : null;
}

/**
 * Production startup migration hook. server/index.ts already executes this exact
 * constant before opening the HTTP port. The leading comment intentionally prevents
 * its single-ALTER optimization from treating the appended multi-statement V7 schema
 * as one ADD COLUMN expression.
 */
export const FACTORY_SUPPLIER_LOCKED_RATE_ADD_COLUMN_SQL = `
/* locked supplier rate + Historical Replay V7 schema */
ALTER TABLE factory_suppliers
  ADD COLUMN IF NOT EXISTS current_raw_material_cost_per_kg_usd NUMERIC(20,8);
${FACTORY_HISTORICAL_REPLAY_V7_SCHEMA_SQL}
`;

export const FACTORY_SUPPLIER_LOCKED_RATE_BACKFILL_MIGRATION_KEY =
  "factory-supplier-locked-raw-material-rate-backfill-v1";

/** Bare legacy backfill used by the existing migration test suite. */
export const FACTORY_SUPPLIER_LOCKED_RATE_BACKFILL_SQL = `
  UPDATE factory_suppliers fs
  SET current_raw_material_cost_per_kg_usd = sub.rate
  FROM (
    SELECT
      c.supplier_id AS supplier_id,
      SUM(rs.received_kg * COALESCE(rs.cost_per_kg_usd, rs.cost_per_kg)) / SUM(rs.received_kg) AS rate
    FROM factory_raw_stock rs
    INNER JOIN factory_containers c ON c.id = rs.container_id
    WHERE rs.deleted_at IS NULL
      AND c.deleted_at IS NULL
      AND c.status != 'DELETED'
      AND c.supplier_id IS NOT NULL
      AND rs.received_kg > 0
    GROUP BY c.supplier_id
    HAVING SUM(rs.received_kg) > 0
  ) sub
  WHERE fs.id = sub.supplier_id
    AND fs.current_raw_material_cost_per_kg_usd IS NULL
`;
