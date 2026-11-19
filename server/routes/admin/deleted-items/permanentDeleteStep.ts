// Extracted from ./permanent-delete.ts: a stage of permanent-delete.
import { db, type DbTransaction } from "../../../db";
import { writeAuditEvent } from "../../../services/audit";
import { sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { isInDeletedItems, PERMANENT_DELETE_ROLES, snapshotRow, rowIdentifier } from "./permanent-deleteHelpers";
import type { Request, Response } from "express";

export async function permanentDeleteStep({ req, res }: { req: Request; res: Response }) {
  if (!PERMANENT_DELETE_ROLES.has(req.user?.role ?? "")) {
    return { done: true as const, value: res.status(403).json({ message: "Forbidden" }) };
  }
  const { type, id } = req.params;
  const itemId = parseInt(id);
  if (isNaN(itemId)) {
    return { done: true as const, value: res.status(400).json({ message: "Invalid item ID" }) };
  }

  const companyId = req.session.currentCompanyId;
  if (!companyId) {
    return { done: true as const, value: res.status(400).json({ message: "No company selected" }) };
  }

  const inDeletedItems = await isInDeletedItems(type, itemId, companyId);
  if (inDeletedItems === null) {
    return { done: true as const, value: res.status(400).json({ message: "Invalid item type" }) };
  }
  if (!inDeletedItems) {
    return { done: true as const, value: res.status(404).json({ message: `${type} not found in Deleted Items` }) };
  }

  const audit = (
    tx: DbTransaction,
    tableName: string,
    row: Record<string, unknown> | null,
    dependents: Record<string, unknown> = {}
  ) =>
    writeAuditEvent(
      {
        userId: req.session.userId ?? "unknown",
        username: req.session.username || "unknown",
        companyId,
        action: "delete",
        tableName,
        recordId: itemId,
        recordIdentifier: rowIdentifier(row),
        changes: {
          permanentDelete: { new: true },
          row: { old: row },
          ...Object.fromEntries(Object.entries(dependents).map(([key, value]) => [key, { old: value }])),
        },
      },
      tx
    );
  /** Snapshot, delete and audit one row of the active company in one transaction. */
  const removeOne = (
    table: PgTable,
    tableName: string,
    remove: (tx: DbTransaction) => Promise<unknown>,
    guard?: (tx: DbTransaction, row: Record<string, unknown> | null) => Promise<void>
  ) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM ${table} t WHERE t.id = ${itemId} FOR UPDATE`);
      const row = await snapshotRow(tx, table, itemId);
      if (guard) await guard(tx, row);
      await remove(tx);
      await audit(tx, tableName, row);
    });

  return { done: false as const, type, itemId, companyId, audit, removeOne };
}
