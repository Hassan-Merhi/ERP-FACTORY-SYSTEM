import { and, eq } from "drizzle-orm";
import { companyScopedSuppliers } from "@shared/schema/supplierCompanyScope";

import { db } from "../../db";
import { logAudit } from "../_helpers";
import {
  assertAccountChangeAllowed,
  countAccountLines,
  lockAccountRow,
} from "../../services/accounting/accountHistoryPolicy";
import { getSupplierBalanceForContext, resolveParentCompanyId } from "../helpers/supplierBalanceHelpers";
import { SupplierRouteError } from "./supplierErrors";
import type { SupplierAuditActor } from "./supplierRequestContext";
import { supplierRepository } from "./supplierRepository";
import { parseCreateSupplierInput, parseSupplierStockGroupId, parseUpdateSupplierInput } from "./supplierValidation";

async function requireSupplier(supplierId: number, companyId: number) {
  const supplier = await supplierRepository.getById(supplierId, companyId);
  if (!supplier) throw new SupplierRouteError(404, "Supplier not found");
  return supplier;
}

async function createUniqueSupplierCode(companyId: number, legalName: string, requestedCode?: string | null) {
  let code = requestedCode?.trim();
  if (code) {
    if (await supplierRepository.getByCode(code, companyId)) {
      throw new SupplierRouteError(400, "Supplier code already exists in this company");
    }
    return code;
  }

  const sanitized = legalName.trim().replace(/[^a-zA-Z0-9]/g, "");
  const baseCode = sanitized.substring(0, 6).toUpperCase() || "SUP";
  code = baseCode;
  let suffix = 1;
  while (await supplierRepository.getByCode(code, companyId)) {
    code = `${baseCode}${suffix}`;
    suffix += 1;
  }
  return code;
}

function supplierAuditChanges(existing: Record<string, unknown>, updated: Record<string, unknown>) {
  const changes: Record<string, { old?: unknown; new?: unknown }> = {};
  for (const field of [
    "legalName",
    "code",
    "phone",
    "email",
    "address",
    "taxId",
    "paymentTerms",
    "openingBalance",
    "active",
  ] as const) {
    if (String(existing?.[field] ?? "") !== String(updated?.[field] ?? "")) {
      changes[field] = { old: existing?.[field], new: updated?.[field] };
    }
  }
  return changes;
}

export const supplierService = {
  async list(companyId: number, search: string, allowParentFallback = false) {
    const suppliers = await supplierRepository.list(companyId, search);
    if (!allowParentFallback) return suppliers;

    // PO Import and other explicitly opted-in master-data pickers may use the
    // linked parent as an inherited supplier source. Keep ordinary supplier
    // routes strict to the active company so a foreign supplier ID cannot be
    // selected outside an intentional inheritance flow.
    const parentCompanyId = await resolveParentCompanyId(companyId);
    if (parentCompanyId === companyId) return suppliers;

    const parentSuppliers = await supplierRepository.list(parentCompanyId, search);
    const deduplicated = new Map<number, (typeof suppliers)[number]>();
    for (const supplier of [...suppliers, ...parentSuppliers]) {
      deduplicated.set(supplier.id, supplier);
    }

    return [...deduplicated.values()].sort((a, b) => {
      const nameOrder = a.legalName.localeCompare(b.legalName);
      return nameOrder !== 0 ? nameOrder : a.id - b.id;
    });
  },

  async stats(companyId: number) {
    let suppliers = await supplierRepository.listAll(companyId);
    if (suppliers.length === 0) {
      const parentCompanyId = await resolveParentCompanyId(companyId);
      if (parentCompanyId !== companyId) {
        suppliers = await supplierRepository.listAll(parentCompanyId);
      }
    }
    // A supplier of another company that this company posted to (owner
    // decision 2): its payable counts here, so it is listed with the lines
    // this company booked. Its opening stays in its own company.
    const listedIds = new Set(suppliers.map((supplier) => supplier.id));
    const postedHere = (await supplierRepository.listPostedFromOtherCompanies(companyId)).filter(
      (supplier) => !listedIds.has(supplier.id)
    );

    return Promise.all(
      [...suppliers, ...postedHere].map(async (supplier) => {
        const [containerCount, balanceResult, purchaseOrders] = await Promise.all([
          supplierRepository.getContainerCount(supplier.id, companyId),
          getSupplierBalanceForContext(supplier, companyId),
          supplierRepository.getPurchaseOrders(supplier.id, companyId),
        ]);

        return {
          ...supplier,
          containerCount,
          balance: balanceResult.balance,
          openingBalance: balanceResult.openingBalance,
          openingBalanceSide: balanceResult.openingBalanceSide,
          balanceBasis: balanceResult.balanceBasis,
          // True for a supplier owned by another company: only this company's postings are counted.
          postedFromOtherCompany: supplier.companyId !== companyId,
          hasActivity: containerCount > 0 || balanceResult.hasActivity || purchaseOrders.length > 0,
        };
      })
    );
  },

  get(supplierId: number, companyId: number) {
    return requireSupplier(supplierId, companyId);
  },

  async balance(supplierId: number, companyId: number) {
    const supplier = await requireSupplier(supplierId, companyId);
    const { balance, openingBalance, openingBalanceSide, balancesByCurrency, historicalBaseBalance, balanceBasis } =
      await getSupplierBalanceForContext(supplier, companyId);
    return { balance, openingBalance, openingBalanceSide, balancesByCurrency, historicalBaseBalance, balanceBasis };
  },

  async create(companyId: number, input: unknown, actor: SupplierAuditActor) {
    const parsed = parseCreateSupplierInput(input, companyId);
    const code = await createUniqueSupplierCode(companyId, parsed.legalName, parsed.code);
    const { role: _role, ...auditActor } = actor;
    // Wave 16 (B): created and audited in one transaction.
    const supplier = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(companyScopedSuppliers)
        .values({
          ...parsed,
          code,
          email: parsed.email || "",
          phone: parsed.phone || "",
          address: parsed.address || "",
          taxId: parsed.taxId || "",
          paymentTerms: parsed.paymentTerms || "",
        })
        .returning();
      await logAudit(
        {
          ...auditActor,
          companyId,
          action: "create",
          tableName: "suppliers",
          recordId: created.id,
          recordIdentifier: created.legalName,
          changes: {
            companyId: { old: null, new: companyId },
            name: { old: null, new: created.legalName },
            code: { old: null, new: created.code },
            phone: { old: null, new: created.phone || null },
            email: { old: null, new: created.email || null },
            address: { old: null, new: created.address || null },
            openingBalance: { old: null, new: created.openingBalance || "0" },
          },
        },
        tx
      );
      return created;
    });

    return supplier;
  },

  async update(supplierId: number, companyId: number, input: unknown, actor: SupplierAuditActor) {
    const existing = await requireSupplier(supplierId, companyId);
    const parsed = parseUpdateSupplierInput(input);

    if (parsed.code && parsed.code !== existing.code) {
      const duplicate = await supplierRepository.getByCode(parsed.code, companyId);
      if (duplicate && duplicate.id !== supplierId) {
        throw new SupplierRouteError(400, "Supplier code already exists in this company");
      }
    }

    // Wave 16 (B): the history rules (a supplier with posted lines changes its
    // opening only by an Admin or Owner) and the audit row in the transaction
    // of the change; the opening-balance lock refuses it after a close.
    const { role, ...auditActor } = actor;
    const updated = await db.transaction(async (tx) => {
      await lockAccountRow(tx, "suppliers", supplierId);
      const [before] = await tx
        .select()
        .from(companyScopedSuppliers)
        .where(and(eq(companyScopedSuppliers.id, supplierId), eq(companyScopedSuppliers.companyId, companyId)));
      if (!before) throw new SupplierRouteError(404, "Supplier not found");
      const after = { ...before, ...parsed };
      assertAccountChangeAllowed({
        role,
        lines: await countAccountLines(tx, [["supplier_id", supplierId]]),
        opening: {
          // This schema does not write the side, so only the amount can change here.
          before: { amount: before.openingBalance },
          after: { amount: after.openingBalance },
          defaultSide: "Cr",
        },
      });
      const [row] = await tx
        .update(companyScopedSuppliers)
        .set(parsed)
        .where(and(eq(companyScopedSuppliers.id, supplierId), eq(companyScopedSuppliers.companyId, companyId)))
        .returning();
      await logAudit(
        {
          ...auditActor,
          companyId,
          action: "update",
          tableName: "suppliers",
          recordId: row.id,
          recordIdentifier: row.legalName,
          changes: supplierAuditChanges(before, row),
        },
        tx
      );
      return row;
    });
    return updated;
  },

  async delete(supplierId: number, companyId: number, actor: SupplierAuditActor) {
    const existing = await requireSupplier(supplierId, companyId);
    const { role: _role, ...auditActor } = actor;
    // Wave 16 (B): retired and audited in one transaction.
    await db.transaction(async (tx) => {
      const [deleted] = await tx
        .update(companyScopedSuppliers)
        .set({ deletedAt: new Date(), active: false })
        .where(and(eq(companyScopedSuppliers.id, supplierId), eq(companyScopedSuppliers.companyId, companyId)))
        .returning({ id: companyScopedSuppliers.id });
      if (!deleted) throw new SupplierRouteError(404, "Supplier not found");
      await logAudit(
        {
          ...auditActor,
          companyId,
          action: "delete",
          tableName: "suppliers",
          recordId: existing.id,
          recordIdentifier: existing.legalName,
          changes: {
            name: { old: existing.legalName, new: null },
            code: { old: existing.code, new: null },
            phone: { old: existing.phone || null, new: null },
            email: { old: existing.email || null, new: null },
            openingBalance: { old: existing.openingBalance || "0", new: null },
          },
        },
        tx
      );
    });
  },

  async assignStockGroup(supplierId: number, companyId: number, input: unknown, actor: SupplierAuditActor) {
    const supplier = await requireSupplier(supplierId, companyId);
    const stockGroupId = parseSupplierStockGroupId(input);
    if (stockGroupId !== null && !(await supplierRepository.stockGroupExists(stockGroupId, companyId))) {
      throw new SupplierRouteError(404, "Stock group not found");
    }

    const updated = await supplierRepository.updateStockGroup(supplierId, companyId, stockGroupId);
    if (!updated) throw new SupplierRouteError(404, "Supplier not found");

    await logAudit({
      ...actor,
      companyId,
      action: "update",
      tableName: "suppliers",
      recordId: supplierId,
      recordIdentifier: supplier.legalName,
      changes: { stockGroupId: { old: supplier.stockGroupId ?? null, new: stockGroupId } },
    });

    return updated;
  },
};
