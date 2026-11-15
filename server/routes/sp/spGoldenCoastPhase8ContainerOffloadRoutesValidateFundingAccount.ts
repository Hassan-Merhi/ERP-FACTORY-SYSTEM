// Extracted from ./spGoldenCoastPhase8ContainerOffloadRoutes.ts to keep that module under the source-size cap.
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { bankAccounts, ledgerAccounts, locations, stockItems } from "@shared/schema";
import { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { privilegedRequestBudget } from "../../middleware/privilegedEndpointSecurity";
import {
  getGoldenCoastAccountDefinition,
  type GoldenCoastAccountRole,
} from "../../services/accounting/goldenCoastPhase2Accounts";
import type {
  GoldenCoastPhase8PostingAccount,
  GoldenCoastPhase8RoleAccounts,
} from "../../services/accounting/goldenCoastPhase8ContainerOffload";
import { type DbLike, isGoldenCoastCompany } from "./spGoldenCoastPhase4CutoverFifoRoutes";
import { GoldenCoastPhase8RouteError } from "./spGoldenCoastPhase8RouteSupport";

export const phase8RequestBudget = privilegedRequestBudget({ maxBodyBytes: 64 * 1024, maxCollectionItems: 100 });

export const PHASE8_MAX_CHARGES = 50;

const PHASE8_ROLES = [
  "stock_otw",
  "stock_in_hand",
  "container_reserve",
  "hassan_equity",
  "hassan_savings",
] as const satisfies readonly GoldenCoastAccountRole[];

export type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function resolveCanonicalRoleAccount(
  conn: DbLike,
  companyId: number,
  role: GoldenCoastAccountRole
): Promise<number> {
  const definition = getGoldenCoastAccountDefinition(role);
  const rows = await conn
    .select({ id: ledgerAccounts.id, accountType: ledgerAccounts.accountType, name: ledgerAccounts.name })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.subType, definition.subType),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .orderBy(asc(ledgerAccounts.id))
    .limit(2);
  if (rows.length !== 1) {
    throw new GoldenCoastPhase8RouteError(
      rows.length === 0
        ? `Golden Coast role ${role} is missing; run Golden Coast account setup first`
        : `Golden Coast role ${role} is ambiguous; repair duplicate ${definition.subType} accounts first`,
      "GC_PHASE8_ROLES_INVALID",
      409
    );
  }
  const row = rows[0];
  if (!definition.acceptedAccountTypes.includes(String(row.accountType))) {
    throw new GoldenCoastPhase8RouteError(
      `Golden Coast role ${role} must use ${definition.acceptedAccountTypes.join(" or ")}; account "${row.name}" is ${row.accountType}`,
      "GC_PHASE8_ROLES_INVALID",
      409
    );
  }
  return Number(row.id);
}

export async function resolveRoleAccounts(conn: DbLike, companyId: number): Promise<GoldenCoastPhase8RoleAccounts> {
  const [stockOtw, stockInHand, reserve, hassanEquity, hassanSavings] = await Promise.all(
    PHASE8_ROLES.map((role) => resolveCanonicalRoleAccount(conn, companyId, role))
  );
  return {
    stockOtwAccountId: stockOtw,
    stockInHandAccountId: stockInHand,
    containerReserveAccountId: reserve,
    hassanEquityAccountId: hassanEquity,
    hassanSavingsAccountId: hassanSavings,
  };
}

export async function assertPhase8Ready(conn: DbLike, companyId: number): Promise<void> {
  if (!(await isGoldenCoastCompany(conn, companyId))) {
    throw new GoldenCoastPhase8RouteError(
      "Golden Coast account setup is not configured for this company",
      "GC_PHASE8_NOT_CONFIGURED",
      409
    );
  }
  await resolveRoleAccounts(conn, companyId);

  // Container activity is available as soon as Golden Coast accounts are
  // configured. Existing inventory is costed lazily by the POS flow, so no
  // opening voucher or FIFO bridge is required first.
}

export async function validateFundingAccount(
  conn: DbLike,
  companyId: number,
  account: GoldenCoastPhase8PostingAccount
): Promise<void> {
  if (account.kind === "bank") {
    const [row] = await conn
      .select({ id: bankAccounts.id })
      .from(bankAccounts)
      .where(
        and(
          eq(bankAccounts.id, account.id),
          eq(bankAccounts.companyId, companyId),
          eq(bankAccounts.active, true),
          isNull(bankAccounts.deletedAt)
        )
      )
      .limit(1);
    if (!row) {
      throw new GoldenCoastPhase8RouteError(
        "fundingAccount must reference an active bank account in this company",
        "GC_PHASE8_FUNDING_ACCOUNT_INVALID"
      );
    }
    return;
  }
  const [row] = await conn
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.id, account.id),
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt),
        inArray(ledgerAccounts.accountType, ["Cash", "Bank"])
      )
    )
    .limit(1);
  if (!row) {
    throw new GoldenCoastPhase8RouteError(
      "fundingAccount must reference an active Cash/Bank ledger account in this company",
      "GC_PHASE8_FUNDING_ACCOUNT_INVALID"
    );
  }
}

export async function validateStockItems(conn: DbLike, companyId: number, ids: readonly number[]): Promise<void> {
  const unique = [...new Set(ids)];
  const rows = await conn
    .select({ id: stockItems.id })
    .from(stockItems)
    .where(
      and(
        eq(stockItems.companyId, companyId),
        inArray(stockItems.id, unique),
        eq(stockItems.active, true),
        isNull(stockItems.deletedAt)
      )
    );
  const found = new Set(rows.map((row) => Number(row.id)));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new GoldenCoastPhase8RouteError(
      `Container lines reference inactive, deleted, or foreign stock item(s): ${missing.join(", ")}`,
      "GC_PHASE8_STOCK_ITEM_INVALID"
    );
  }
}

export async function validateSupplier(conn: DbLike, companyId: number, supplierId: number | null): Promise<void> {
  if (supplierId == null) return;
  const result = await conn.execute(sql`
    SELECT s.id
    FROM suppliers s
    INNER JOIN stock_groups sg ON sg.id = s.stock_group_id
    WHERE s.id = ${supplierId}
      AND s.active = true
      AND s.deleted_at IS NULL
      AND sg.company_id = ${companyId}
    LIMIT 1
  `);
  if (!resultRows(result)[0]) {
    throw new GoldenCoastPhase8RouteError(
      "supplierId must reference an active supplier mapped to this company; otherwise omit supplierId and retain supplierName",
      "GC_PHASE8_SUPPLIER_INVALID"
    );
  }
}

export async function validateLocation(conn: DbLike, companyId: number, locationId: number): Promise<void> {
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
    throw new GoldenCoastPhase8RouteError(
      `Location ${locationId} is not an active location in this company`,
      "GC_PHASE8_LOCATION_INVALID"
    );
  }
}
