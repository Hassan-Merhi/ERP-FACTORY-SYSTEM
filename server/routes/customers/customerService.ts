import { and, eq, sql } from "drizzle-orm";
import { customers, insertCustomerSchema, ledgerAccounts } from "@shared/schema";

import { db } from "../../db";
import { storage } from "../../storage";
import { logAudit } from "../_helpers";
import { getCustomersWithBalances } from "./customerBalanceQuery";
import { CustomerRouteError } from "./customerErrors";
import type { CustomerAuditActor } from "./customerRequestContext";

async function requireCustomer(customerId: number, companyId: number) {
  const customer = await storage.getCustomerById(customerId);
  if (!customer) throw new CustomerRouteError(404, "Customer not found");
  if (customer.companyId !== companyId) {
    throw new CustomerRouteError(403, "Access denied: Customer belongs to a different company");
  }
  return customer;
}

async function writeCustomerAudit(params: Parameters<typeof logAudit>[0]): Promise<void> {
  try {
    await logAudit(params);
  } catch {
    // Customer mutations remain authoritative when the non-critical audit adapter is unavailable.
  }
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

  async transactions(customerId: number, companyId: number, startDate?: string, endDate?: string) {
    const customer = await requireCustomer(customerId, companyId);
    if (customer.ledgerAccountId) {
      return storage.getVoucherEntriesByLedger(customer.ledgerAccountId, startDate, endDate, companyId);
    }
    return storage.getVoucherEntriesByCustomer(customerId, startDate, endDate);
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
    const customer = await storage.createCustomer({ ...parsed, code });

    await writeCustomerAudit({
      ...actor,
      companyId,
      action: "create",
      tableName: "customers",
      recordId: customer.id,
      recordIdentifier: customer.legalName,
      changes: {
        name: { old: null, new: customer.legalName },
        code: { old: null, new: customer.code },
        phone: { old: null, new: customer.phone || null },
        openingBalance: { old: null, new: customer.openingBalance || "0" },
        openingBalanceSide: { old: null, new: customer.openingBalanceSide || null },
      },
    });

    const ledgerCode = `CUST-${customer.code}`;
    let ledgerAccount = await storage.getLedgerAccountByCode(ledgerCode, companyId);
    if (!ledgerAccount) {
      ledgerAccount = await storage.createLedgerAccount({
        companyId,
        code: ledgerCode,
        name: `${customer.legalName} - Customer Account`,
        accountType: "Asset",
        subType: "Accounts Receivable",
        openingBalance: parsed.openingBalance || "0",
        openingBalanceSide: parsed.openingBalanceSide || "Dr",
        active: true,
      });
      await storage.updateCustomer(customer.id, { ledgerAccountId: ledgerAccount.id });
    }

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
    const updated = await storage.updateCustomer(customerId, parsed);
    await writeCustomerAudit({
      ...actor,
      companyId,
      action: "update",
      tableName: "customers",
      recordId: updated.id,
      recordIdentifier: updated.legalName,
      changes: customerChanges(existing, updated),
    });

    if (updated.ledgerAccountId && (parsed.openingBalance !== undefined || parsed.openingBalanceSide !== undefined)) {
      const ledgerUpdate: { openingBalance?: string; openingBalanceSide?: string } = {};
      if (parsed.openingBalance !== undefined) ledgerUpdate.openingBalance = updated.openingBalance ?? "0";
      if (parsed.openingBalanceSide !== undefined) {
        ledgerUpdate.openingBalanceSide = updated.openingBalanceSide ?? "Dr";
      }
      if (Object.keys(ledgerUpdate).length > 0) {
        await storage.updateLedgerAccount({ id: updated.ledgerAccountId, ...ledgerUpdate } as {
          id: number;
          active?: boolean | undefined;
          deletedAt?: Date | null | undefined;
          isHidden?: boolean | undefined;
          companyId?: number | undefined;
          code?: string | undefined;
          name?: string | undefined;
          accountType?:
            | "Asset"
            | "Liability"
            | "Equity"
            | "Income"
            | "Expense"
            | "Bank"
            | "Cash"
            | "Indirect Expense"
            | "Direct Expense"
            | "Government Taxes"
            | "Loans"
            | "Duty Agent"
            | "Transporter Agent"
            | "Accounts Payable"
            | "Profit"
            | undefined;
          subType?: string | null | undefined;
          openingBalance?: string | undefined;
          openingBalanceSide?: "" | "Dr" | "Cr" | undefined;
          openingBalanceNativeAmount?: string | null | undefined;
          openingBalanceCurrency?: "USD" | "CFA" | null | undefined;
          openingBalanceHistoricalRate?: string | null | undefined;
          openingBalanceBaseAmount?: string | null | undefined;
          parentId?: number | null | undefined;
        });
      }
    }

    return updated;
  },

  async delete(customerId: number, companyId: number, actor: CustomerAuditActor) {
    const existing = await requireCustomer(customerId, companyId);
    await storage.deleteCustomer(customerId);
    await writeCustomerAudit({
      ...actor,
      companyId,
      action: "delete",
      tableName: "customers",
      recordId: existing.id,
      recordIdentifier: existing.legalName,
      changes: {
        name: { old: existing.legalName, new: null },
        code: { old: existing.code, new: null },
        phone: { old: existing.phone || null, new: null },
      },
    });
  },
};
