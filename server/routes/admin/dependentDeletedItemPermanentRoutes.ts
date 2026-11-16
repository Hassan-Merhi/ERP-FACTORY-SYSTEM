import type { Express, NextFunction, Request, Response } from "express";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../../db";
import { requireAuth, requireNonPOS } from "../../auth";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { customerOrders, factoryContainers, factoryMixBatches } from "@shared/schema";

const PERMANENT_DELETE_PATH = "/api/deleted-items/:type/:id/permanent";
const HANDLED_TYPES = new Set<string>(["factoryContainer", "factoryMixBatch", "customerOrder"]);
const PERMANENT_DELETE_LOCK_NAMESPACE = 20260729;

type RestrictiveReference = {
  schema_name: string;
  table_name: string;
  column_name: string;
  column_not_null: boolean;
  constraint_name: string;
};

type DatabaseErrorMetadata = {
  message?: string;
  code?: string;
  constraint?: string;
  table?: string;
  column?: string;
  detail?: string;
};

function executeRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (typeof result === "object" && result !== null && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    return Array.isArray(rows) ? (rows as T[]) : [];
  }
  return [];
}

function extractDatabaseErrorMetadata(error: unknown): DatabaseErrorMetadata {
  const metadata: DatabaseErrorMetadata = {};
  let current: unknown = error;
  const seen = new Set<object>();

  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof current !== "object" || current === null || seen.has(current)) break;
    seen.add(current);
    const record = current as Record<string, unknown>;

    for (const field of ["message", "code", "constraint", "table", "column", "detail"] as const) {
      const value = record[field];
      if (typeof value === "string" && value.length > 0) metadata[field] = value;
    }

    current = record.cause;
  }

  return metadata;
}

/**
 * Production databases can contain restrictive foreign keys created by older
 * migrations that are no longer represented in the current Drizzle schema.
 * After the known business-specific cleanup runs, inspect PostgreSQL's catalog
 * and clear any remaining single-column RESTRICT/NO ACTION references to the
 * parent's id. Nullable references are detached; required child rows are
 * deleted because the user explicitly chose Delete Forever.
 */
async function clearRemainingRestrictiveReferences(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  parentTable: "factory_containers" | "factory_mix_batches" | "customer_orders",
  parentId: number
): Promise<void> {
  const result = await tx.execute(sql`
    SELECT
      child_ns.nspname AS schema_name,
      child.relname AS table_name,
      child_column.attname AS column_name,
      child_column.attnotnull AS column_not_null,
      constraint_row.conname AS constraint_name
    FROM pg_constraint constraint_row
    JOIN pg_class parent ON parent.oid = constraint_row.confrelid
    JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
    JOIN pg_class child ON child.oid = constraint_row.conrelid
    JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
    JOIN LATERAL unnest(constraint_row.conkey) WITH ORDINALITY AS child_key(attnum, ord) ON TRUE
    JOIN LATERAL unnest(constraint_row.confkey) WITH ORDINALITY AS parent_key(attnum, ord)
      ON parent_key.ord = child_key.ord
    JOIN pg_attribute child_column
      ON child_column.attrelid = child.oid AND child_column.attnum = child_key.attnum
    JOIN pg_attribute parent_column
      ON parent_column.attrelid = parent.oid AND parent_column.attnum = parent_key.attnum
    WHERE constraint_row.contype = 'f'
      AND parent_ns.nspname = 'public'
      AND child_ns.nspname = 'public'
      AND parent.relname = ${parentTable}
      AND parent_column.attname = 'id'
      AND cardinality(constraint_row.conkey) = 1
      AND constraint_row.confdeltype IN ('a', 'r')
    ORDER BY child_ns.nspname, child.relname, constraint_row.conname
  `);

  const references = executeRows<RestrictiveReference>(result);
  for (const reference of references) {
    const qualifiedTable = sql.identifier(reference.schema_name, reference.table_name);
    const column = sql.identifier(reference.column_name);
    const statement = reference.column_not_null
      ? sql`DELETE FROM ${qualifiedTable} WHERE ${column} = ${parentId}`
      : sql`UPDATE ${qualifiedTable} SET ${column} = NULL WHERE ${column} = ${parentId}`;

    await tx.execute(statement);
  }
}

/**
 * Handles permanent deletion for records whose dependent tables are not fully
 * represented by the older Deleted Items route. Register this route before
 * registerDeletedItemsRoutes; unhandled types skip to the legacy route.
 */
export function registerDependentDeletedItemPermanentRoutes(app: Express): void {
  app.delete(
    PERMANENT_DELETE_PATH,
    (req: Request, _res: Response, next: NextFunction) => {
      if (!HANDLED_TYPES.has(req.params.type)) return next("route");
      return next();
    },
    requireAuth,
    requireNonPOS,
    async (req: Request, res: Response) => {
      const { type } = req.params;
      const itemId = Number.parseInt(req.params.id, 10);
      if (!Number.isSafeInteger(itemId) || itemId <= 0) {
        return res.status(400).json({ message: "Invalid item ID" });
      }

      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      try {
        const deleted = await db.transaction(async (tx) => {
          // The Deleted Items screen sends bulk requests together. Serialize every
          // destructive cleanup for the same company on this transaction's existing
          // connection, avoiding cross-linked mix-batch deadlocks without consuming
          // a second pool connection per waiting request.
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(${PERMANENT_DELETE_LOCK_NAMESPACE}::integer, ${companyId}::integer)`
          );

          if (type === "factoryContainer") {
            const [target] = await tx
              .select({ id: factoryContainers.id })
              .from(factoryContainers)
              .where(
                and(
                  eq(factoryContainers.id, itemId),
                  eq(factoryContainers.companyId, companyId),
                  isNotNull(factoryContainers.deletedAt)
                )
              )
              .limit(1);
            if (!target) return false;

            await tx.execute(
              sql`DELETE FROM factory_container_receipts WHERE container_id = ${itemId} AND company_id = ${companyId}`
            );
            await tx.execute(sql`DELETE FROM factory_container_tracking_events WHERE container_id = ${itemId}`);
            await tx.execute(sql`DELETE FROM factory_container_tracking_checks WHERE container_id = ${itemId}`);
            await tx.execute(
              sql`DELETE FROM factory_waste_entries WHERE container_id = ${itemId} AND company_id = ${companyId}`
            );
            await tx.execute(
              sql`DELETE FROM factory_duty_audit_log WHERE container_id = ${itemId} AND company_id = ${companyId}`
            );
            await tx.execute(
              sql`DELETE FROM factory_fx_allocations WHERE container_id = ${itemId} AND company_id = ${companyId}`
            );
            await tx.execute(
              sql`DELETE FROM factory_container_commissions WHERE container_id = ${itemId} AND company_id = ${companyId}`
            );
            await tx.execute(sql`DELETE FROM factory_mix_batch_sources WHERE container_id = ${itemId}`);
            await tx.execute(
              sql`DELETE FROM factory_raw_stock WHERE container_id = ${itemId} AND company_id = ${companyId}`
            );
            await tx.execute(
              sql`DELETE FROM factory_offload_additional_charges WHERE container_id = ${itemId} AND company_id = ${companyId}`
            );
            await tx.execute(
              sql`DELETE FROM factory_container_other_charges WHERE container_id = ${itemId} AND company_id = ${companyId}`
            );
            await tx.execute(
              sql`DELETE FROM factory_container_profit_snapshots WHERE container_id = ${itemId} AND company_id = ${companyId}`
            );

            await clearRemainingRestrictiveReferences(tx, "factory_containers", itemId);

            const removed = await tx
              .delete(factoryContainers)
              .where(
                and(
                  eq(factoryContainers.id, itemId),
                  eq(factoryContainers.companyId, companyId),
                  isNotNull(factoryContainers.deletedAt)
                )
              )
              .returning({ id: factoryContainers.id });
            return removed.length === 1;
          }

          if (type === "factoryMixBatch") {
            const [target] = await tx
              .select({ id: factoryMixBatches.id })
              .from(factoryMixBatches)
              .where(
                and(
                  eq(factoryMixBatches.id, itemId),
                  eq(factoryMixBatches.companyId, companyId),
                  isNotNull(factoryMixBatches.deletedAt)
                )
              )
              .limit(1);
            if (!target) return false;

            await tx.execute(sql`DELETE FROM factory_mix_batch_sources WHERE mix_batch_id = ${itemId}`);
            await tx.execute(sql`
              UPDATE factory_mix_batch_sources
              SET source_batch_id = NULL,
                  source_id = CASE WHEN source_type = 'BATCH' THEN NULL ELSE source_id END
              WHERE source_batch_id = ${itemId}
                 OR (source_type = 'BATCH' AND source_id = ${itemId})
            `);
            await tx.execute(
              sql`DELETE FROM factory_daily_usages WHERE mix_batch_id = ${itemId} AND company_id = ${companyId}`
            );
            await tx.execute(sql`
              UPDATE factory_mix_batches
              SET carry_forward_from_id = NULL
              WHERE carry_forward_from_id = ${itemId} AND company_id = ${companyId}
            `);
            await tx.execute(sql`
              UPDATE factory_pressing_batches
              SET mix_batch_id = NULL
              WHERE mix_batch_id = ${itemId} AND company_id = ${companyId}
            `);
            await tx.execute(sql`
              UPDATE factory_bales
              SET mix_batch_id = NULL
              WHERE mix_batch_id = ${itemId} AND company_id = ${companyId}
            `);
            await tx.execute(sql`
              UPDATE factory_waste_entries
              SET mix_batch_id = NULL
              WHERE mix_batch_id = ${itemId} AND company_id = ${companyId}
            `);

            await clearRemainingRestrictiveReferences(tx, "factory_mix_batches", itemId);

            const removed = await tx
              .delete(factoryMixBatches)
              .where(
                and(
                  eq(factoryMixBatches.id, itemId),
                  eq(factoryMixBatches.companyId, companyId),
                  isNotNull(factoryMixBatches.deletedAt)
                )
              )
              .returning({ id: factoryMixBatches.id });
            return removed.length === 1;
          }

          const [target] = await tx
            .select({ id: customerOrders.id })
            .from(customerOrders)
            .where(
              and(
                eq(customerOrders.id, itemId),
                eq(customerOrders.companyId, companyId),
                isNotNull(customerOrders.deletedAt)
              )
            )
            .limit(1);
          if (!target) return false;

          await tx.execute(
            sql`DELETE FROM factory_invoice_loading_bales WHERE invoice_id = ${itemId} AND company_id = ${companyId}`
          );
          await tx.execute(
            sql`DELETE FROM factory_invoice_loading_sessions WHERE invoice_id = ${itemId} AND company_id = ${companyId}`
          );
          await tx.execute(sql`
            DELETE FROM factory_shipping_container_documents
            WHERE scr_id IN (
              SELECT id FROM factory_shipping_container_rows
              WHERE customer_order_id = ${itemId} AND company_id = ${companyId}
            )
          `);
          await tx.execute(sql`
            DELETE FROM factory_shipping_container_rows
            WHERE customer_order_id = ${itemId} AND company_id = ${companyId}
          `);
          await tx.execute(sql`DELETE FROM customer_order_bale_removals WHERE order_id = ${itemId}`);
          await tx.execute(sql`DELETE FROM customer_order_expected_lines WHERE order_id = ${itemId}`);
          await tx.execute(sql`DELETE FROM customer_order_bales_history WHERE order_id = ${itemId}`);
          await tx.execute(sql`DELETE FROM customer_order_bales WHERE order_id = ${itemId}`);
          await tx.execute(sql`DELETE FROM customer_order_lines WHERE order_id = ${itemId}`);
          await tx.execute(sql`DELETE FROM customer_order_charges WHERE order_id = ${itemId}`);

          await clearRemainingRestrictiveReferences(tx, "customer_orders", itemId);

          const removed = await tx
            .delete(customerOrders)
            .where(
              and(
                eq(customerOrders.id, itemId),
                eq(customerOrders.companyId, companyId),
                isNotNull(customerOrders.deletedAt)
              )
            )
            .returning({ id: customerOrders.id });
          return removed.length === 1;
        });

        if (!deleted) {
          return res.status(404).json({ message: `${type} not found in Deleted Items` });
        }

        return res.json({ message: `${type} permanently deleted` });
      } catch (error: unknown) {
        const databaseError = extractDatabaseErrorMetadata(error);
        logger.error("Permanent deleted-item cleanup failed", {
          error,
          type,
          itemId,
          companyId,
          dbErrorCode: databaseError.code,
          dbConstraint: databaseError.constraint,
          dbTable: databaseError.table,
          dbColumn: databaseError.column,
          dbDetail: databaseError.detail,
        });
        return res.status(500).json({
          message: databaseError.message || getErrorMessage(error),
          ...(databaseError.code ? { code: databaseError.code } : {}),
          ...(databaseError.constraint ? { constraint: databaseError.constraint } : {}),
        });
      }
    }
  );
}
