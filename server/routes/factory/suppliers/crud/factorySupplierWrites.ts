/**
 * Factory supplier master writes (wave 16 B).
 *
 * A factory supplier's opening is a balance the engine counts (Cr when it has
 * no side), so it follows the rules for accounts with history
 * (services/accounting/accountHistoryPolicy.ts): with posted lines, only an
 * Admin or Owner changes it; a supplier with lines never moves company; every
 * create and update is audited in its own transaction; and after a close the
 * opening-balance lock refuses an opening change.
 */
import { and, eq } from "drizzle-orm";
import { factorySuppliers, insertFactorySupplierSchema } from "@shared/schema";

import type { DatabaseOrTransaction } from "../../../../db";
import { parseMoneyInput } from "../../../../lib/money";
import { buildAuditChanges, writeAuditEvent } from "../../../../services/audit";
import {
  assertAccountChangeAllowed,
  countAccountLines,
  lockAccountRow,
} from "../../../../services/accounting/accountHistoryPolicy";

export class FactorySupplierWriteError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export interface FactorySupplierActor {
  userId: string;
  username: string;
  role: string | null | undefined;
}

const AUDIT_FIELDS = [
  "name",
  "companyId",
  "contactPerson",
  "phone",
  "email",
  "address",
  "notes",
  "openingBalance",
  "linkedSupplierId",
  "parentId",
  "supplierCategoryId",
  "isActive",
  "isBroker",
];

/** Fields an edit may change (id, timestamps and the locked raw-material cost are not editable here). */
export const factorySupplierUpdateSchema = insertFactorySupplierSchema
  .omit({ currentRawMaterialCostPerKgUsd: true })
  .partial();

/** An opening amount as exact decimal text; throws 400 on anything that is not a number. */
export function parseFactorySupplierOpening(value: unknown): string {
  const parsed = parseMoneyInput(value);
  if (!parsed || !parsed.isFinite()) {
    throw new FactorySupplierWriteError(400, "openingBalance must be a valid number");
  }
  return parsed.toFixed();
}

export async function createFactorySupplierTx(
  tx: DatabaseOrTransaction,
  companyId: number,
  input: unknown,
  actor: FactorySupplierActor
) {
  const parsed = insertFactorySupplierSchema.parse({
    ...(input && typeof input === "object" ? input : {}),
    companyId,
  });
  if (parsed.openingBalance !== undefined) parsed.openingBalance = parseFactorySupplierOpening(parsed.openingBalance);
  const [created] = await tx.insert(factorySuppliers).values(parsed).returning();
  await writeAuditEvent(
    {
      userId: actor.userId,
      username: actor.username,
      companyId,
      action: "create",
      tableName: "factory_suppliers",
      recordId: created.id,
      recordIdentifier: created.name,
      changes: buildAuditChanges(null, created, AUDIT_FIELDS),
    },
    tx
  );
  return created;
}

/**
 * Applies `updates` to the company's supplier under the history rules and
 * audits the change. Returns null when the supplier does not exist in the
 * company.
 */
export async function updateFactorySupplierTx(
  tx: DatabaseOrTransaction,
  companyId: number,
  id: number,
  updates: Partial<typeof factorySuppliers.$inferInsert>,
  actor: FactorySupplierActor,
  action: "update" | "import" = "update"
) {
  await lockAccountRow(tx, "factory_suppliers", id);
  const [before] = await tx
    .select()
    .from(factorySuppliers)
    .where(and(eq(factorySuppliers.id, id), eq(factorySuppliers.companyId, companyId)));
  if (!before) return null;
  const values = { ...updates };
  delete values.id;
  if (values.companyId === before.companyId) delete values.companyId;
  if (values.openingBalance !== undefined) values.openingBalance = parseFactorySupplierOpening(values.openingBalance);
  const after = { ...before, ...values };
  assertAccountChangeAllowed({
    role: actor.role,
    lines: await countAccountLines(tx, [["factory_supplier_id", id]]),
    opening: {
      before: { amount: before.openingBalance },
      after: { amount: after.openingBalance },
      defaultSide: "Cr",
    },
    company: { before: before.companyId, after: values.companyId },
  });
  const [updated] = await tx
    .update(factorySuppliers)
    .set({ ...values, updatedAt: new Date() })
    .where(and(eq(factorySuppliers.id, id), eq(factorySuppliers.companyId, companyId)))
    .returning();
  const changes = buildAuditChanges(before, updated, AUDIT_FIELDS);
  if (Object.keys(changes).length > 0) {
    await writeAuditEvent(
      {
        userId: actor.userId,
        username: actor.username,
        companyId,
        action,
        tableName: "factory_suppliers",
        recordId: updated.id,
        recordIdentifier: updated.name,
        changes,
      },
      tx
    );
  }
  return updated;
}
