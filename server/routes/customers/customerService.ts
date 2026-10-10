import { and, eq, sql } from "drizzle-orm";
import { customers, insertCustomerSchema, ledgerAccounts } from "@shared/schema";

import { db } from "../../db";
import { storage } from "../../storage";
import { logAudit } from "../_helpers";
import { getCustomersWithBalances } from "./customerBalanceQuery";
import { loadCustomerLedgerEntryRows } from "../../services/accounting/balances/customerLedgerStatement";
import { CustomerRouteError } from "./customerErrors";
import {
  assertAccountChangeAllowed,
  countAccountLines,
  lockAccountRow,
} from "../../services/accounting/accountHistoryPolicy";
import type { CustomerAuditActor } from "./customerRequestContext";

async function requireCustomer(customerId: number, companyId: number) {
  const customer = await storage.getCustomerById(customerId);
  if (!customer) throw new CustomerRouteError(404, "Customer not found");
  if (customer.companyId !== companyId) {
    throw new CustomerRouteError(403, "Access denied: Customer belongs to a different company");
  }
  return customer;
}

function customerChanges(existing: Record<string, unknown>, updated: Record<string, unknown>) {
  const changes: Record<string, { old?: unknown; new?: unknown }> = {};
  for (const field of [
    "legalName",
    "phone",
    "email",
    "address",
    "openingBalance",
    "openingBalanceSide",
    "active",
  ] as const) {
    if (String(existing?.[field] ?? "") !== String(updated?.[field] ?? "")) {
      changes[field] = { old: existing?.[field], new: updated?.[field] };
    }
  }
  return changes;
}

async function nextCustomerCode(companyId: number): Promise<string> {
  const [maxRow] = await db
    .select({
      maxSuffix: sql<string>`MAX(CAST(NULLIF(REGEXP_REPLACE(code, '[^0-9]', '', 'g'), '') AS integer))`,
    })
    .from(customers)
    .where(and(eq(customers.companyId, companyId), sql`code LIKE 'CUST%'`))
    .execute();

  let suffix = maxRow?.maxSuffix ? Number.parseInt(maxRow.maxSuffix, 10) + 1 : 1;
  let code = `CUST${suffix.toString().padStart(3, "0")}`;
  while (await storage.getCustomerByCode(code, companyId)) {
    suffix += 1;
    code = `CUST${suffix.toString().padStart(3, "0")}`;
  }
  return code;
}

export const customerService = {
  async forPos(companyId: number) {
    const customers = await storage.getAllCustomers(companyId);
    return customers.map((customer) => ({ id: customer.id, legalName: customer.legalName }));
  },

  list(companyId: number, search?: string) {
    return storage.getAllCustomers(companyId, search, search ? 50 : undefined);
  },

  stats(companyId: number) {
    return getCustomersWithBalances(companyId);
  },

  get(customerId: number, companyId: number) {
    return requireCustomer(customerId, companyId);
  },

  /**
   * The customer's statement lines on the balance engine (wave 13, A3): its
   * owned linked ledger plus its customer-tagged lines that name no other
   * target (partyLineRules.customerOwnedLineSql), posted vouchers of this
   * company only, dated COALESCE(effective_date, voucher_date). So opening +
   * these lines foots to the engine balance the Customers page shows.
   */
  async transactions(customerId: number, companyId: number, startDate?: string, endDate?: string) {
    await requireCustomer(customerId, companyId);
    return loadCustomerLedgerEntryRows(db, { companyId, customerId, from: startDate ?? null, to: endDate ?? null });
  },

  async create(companyId: number, input: unknown, actor: CustomerAuditActor) {
    const parsed = insertCustomerSchema.parse({
      ...(input && typeof input === "object" ? input : {}),
      companyId,
    });
    if (parsed.ledgerAccountId !== undefined) {
      const [linkedLedger] = await db
        .select({ id: ledgerAccounts.id })
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.id, parsed.ledgerAccountId), eq(ledgerAccounts.companyId, companyId)))
        .limit(1);
      if (!linkedLedger) {
        throw new CustomerRouteError(400, "Linked ledger account must belong to the customer company");
      }
    }
    const code = await nextCustomerCode(companyId);
    const ledgerCode = `CUST-${code}`;
    const existingLedger = await storage.getLedgerAccountByCode(ledgerCode, companyId);
    const { role: _role, ...auditActor } = actor;
    // Wave 16 (B): the customer, its ledger account and the audit row are
    // written in one transaction (the audit was best-effort after the insert).
    const customer = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(customers)
        .values({ ...parsed, code })
        .returning();
      await logAudit(
        {
          ...auditActor,
          companyId,
          action: "create",
          tableName: "customers",
          recordId: created.id,
          recordIdentifier: created.legalName,
          changes: {
            name: { old: null, new: created.legalName },
            code: { old: null, new: created.code },
            phone: { old: null, new: created.phone || null },
            openingBalance: { old: null, new: created.openingBalance || "0" },
            openingBalanceSide: { old: null, new: created.openingBalanceSide || null },
          },
        },
        tx
      );

      if (!existingLedger) {
        const [ledgerAccount] = await tx
          .insert(ledgerAccounts)
          .values({
            companyId,
            code: ledgerCode,
            name: `${created.legalName} - Customer Account`,
            accountType: "Asset",
            subType: "Accounts Receivable",
            // The customer record owns the opening (owner rule 1): the balance
            // engine counts customers.opening_balance once and ignores the linked
            // ledger's own opening, so the new ledger starts at zero instead of a
            // copy that every ledger-only reader used to add a second time.
            openingBalance: "0",
            openingBalanceSide: "Dr",
            active: true,
          })
          .returning();
        const [linked] = await tx
          .update(customers)
          .set({ ledgerAccountId: ledgerAccount.id })
          .where(eq(customers.id, created.id))
          .returning();
        return linked;
      }
      return created;
    });

    return customer;
  },

  async update(customerId: number, companyId: number, input: unknown, actor: CustomerAuditActor) {
    const existing = await requireCustomer(customerId, companyId);
    const body = input && typeof input === "object" ? { ...(input as Record<string, unknown>) } : {};
    delete body.companyId;

    if (body.code && body.code !== existing.code) {
      const duplicate = await storage.getCustomerByCode(String(body.code), companyId);
      if (duplicate) throw new CustomerRouteError(400, "Customer code already exists in this company");
    }

    const parsed = insertCustomerSchema.omit({ companyId: true }).partial().parse(body);
    if (parsed.ledgerAccountId !== undefined) {
      const [linkedLedger] = await db
        .select({ id: ledgerAccounts.id })
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.id, parsed.ledgerAccountId), eq(ledgerAccounts.companyId, companyId)))
        .limit(1);
      if (!linkedLedger) {
        throw new CustomerRouteError(400, "Linked ledger account must belong to the customer company");
      }
    }
    // Wave 16 (B): the history rules (a customer with posted lines changes its
    // opening only by an Admin or Owner) and the audit row in the transaction
    // of the change; the opening-balance lock refuses it after a close.
    const { role, ...auditActor } = actor;
    const updated = await db.transaction(async (tx) => {
      await lockAccountRow(tx, "customers", customerId);
      const [before] = await tx.select().from(customers).where(eq(customers.id, customerId));
      if (!before) throw new CustomerRouteError(404, "Customer not found");
      const after = { ...before, ...parsed };
      assertAccountChangeAllowed({
        role,
        lines: await countAccountLines(tx, [
          ["customer_id", customerId],
          ["ledger_account_id", before.ledgerAccountId],
        ]),
        opening: {
          before: { amount: before.openingBalance, side: before.openingBalanceSide },
          after: { amount: after.openingBalance, side: after.openingBalanceSide },
          defaultSide: "Dr",
        },
      });
      const [row] = await tx.update(customers).set(parsed).where(eq(customers.id, customerId)).returning();
      await logAudit(
        {
          ...auditActor,
          companyId,
          action: "update",
          tableName: "customers",
          recordId: row.id,
          recordIdentifier: row.legalName,
          changes: customerChanges(before, row),
        },
        tx
      );
      return row;
    });

    // The customer record owns its opening (owner rule 1). It is no longer
    // copied onto the linked ledger account, whose own opening the balance
    // engine never counts.

    return updated;
  },

  async delete(customerId: number, companyId: number, actor: CustomerAuditActor) {
    const existing = await requireCustomer(customerId, companyId);
    const { role: _role, ...auditActor } = actor;
    // Wave 16 (B): retired and audited in one transaction.
    await db.transaction(async (tx) => {
      await tx
        .update(customers)
        .set({ deletedAt: new Date(), active: false })
        .where(and(eq(customers.id, customerId), eq(customers.companyId, companyId)));
      await logAudit(
        {
          ...auditActor,
          companyId,
          action: "delete",
          tableName: "customers",
          recordId: existing.id,
          recordIdentifier: existing.legalName,
          changes: {
            name: { old: existing.legalName, new: null },
            code: { old: existing.code, new: null },
            phone: { old: existing.phone || null, new: null },
            openingBalance: { old: existing.openingBalance || "0", new: null },
          },
        },
        tx
      );
    });
  },
};
