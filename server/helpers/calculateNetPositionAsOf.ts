/**
 * Shared helper: calculate the ERP net position as of a specific date.
 *
 * Returns the four summary values PLUS a full breakdown of every line item
 * on both sides (What We Have / What We Owe) so callers can build detailed
 * per-month sheets.
 */

import { db, type RawQueryRow } from "../db";
import { storage } from "../storage";
import { locations, employees, containers } from "@shared/schema";
import { eq, and, or, isNull, lte, sql } from "drizzle-orm";
import { classifyEquityAccounts, classifyNetPositionAccounts, round2 } from "../netPositionHelper";
import { calculateHistoricalLocationInventory } from "../routes/_helpers";
import { getSupplierPartnerCustomerNetPosition } from "./supplierPartnerCustomerNetPosition";
import { toFiniteNumber, toPositiveInteger } from "@shared/typeGuards";
import { companyScopedSuppliers } from "@shared/schema/supplierCompanyScope";
import { computeEmployeeNetPositionWithManagedAdvances } from "./employeeNetPosition";
import { loadSalaryAdvanceNetPositionAdjustments } from "./salaryAdvanceNetPosition";

/**
 * The two grouped balance projections read below.
 *
 * PostgreSQL returns `SUM(numeric)` as a string and returns NULL for a group
 * with no rows, so the amount columns are declared as they really arrive and
 * are parsed through `toFiniteNumber` rather than coerced blindly — `Number(null)`
 * would post a silent zero into a balance.
 */
interface GroupedBalanceRow {
  total_debit: string | number | null;
  total_credit: string | number | null;
}

interface LedgerBalanceRow extends GroupedBalanceRow {
  ledger_account_id: number | string | null;
}

interface PartyBalanceRow extends GroupedBalanceRow {
  supplier_id: number | string | null;
  employee_id: number | string | null;
}

function groupedAmounts(row: GroupedBalanceRow): { debit: number; credit: number } {
  return {
    debit: toFiniteNumber(row.total_debit) ?? 0,
    credit: toFiniteNumber(row.total_credit) ?? 0,
  };
}

export interface NetPositionLineItem {
  label: string;
  value: number;
  category: string;
  side: "forUs" | "onUs";
}

export interface NetPositionSnapshot {
  forUsTotal: number;
  onUsTotal: number;
  netPosition: number;
  netPositionLabel: string;
  forUsLines: NetPositionLineItem[];
  onUsLines: NetPositionLineItem[];
}

export async function calculateNetPositionAsOf(
  companyId: number,
  toDate: string // YYYY-MM-DD
): Promise<NetPositionSnapshot> {
  const companyAccounts = await storage.getAllLedgerAccounts(companyId, true);
  const companyRow = await storage.getCompanyById(companyId);
  const isSupplierPartner = companyRow?.companyType === "supplier_partner";

  // Two separate aggregation queries — same rationale as the net-profit route:
  //
  //   acctGrouped  — filters by ACCOUNT's company_id so that ledger accounts
  //                  migrated between companies show their full balance in the
  //                  destination company even when their vouchers weren't moved.
  //
  //   suppGrouped  — filters by VOUCHER's company_id for supplier/employee
  //                  balances, which are always booked to the voucher's company.
  const loadAccountBalances = async () => {
    try {
      return await db.execute<RawQueryRow<LedgerBalanceRow>>(sql`
        SELECT
          ve.ledger_account_id,
          SUM(CAST(COALESCE(ve.base_debit_amount, ve.debit_amount) AS numeric)) AS total_debit,
          SUM(CAST(COALESCE(ve.base_credit_amount, ve.credit_amount) AS numeric)) AS total_credit
        FROM voucher_entries ve
        INNER JOIN vouchers v ON ve.voucher_id = v.id
        INNER JOIN ledger_accounts la ON ve.ledger_account_id = la.id
        WHERE la.company_id = ${companyId}
          AND v.optional = false
          AND v.deleted_at IS NULL
          AND v.voucher_date <= ${toDate}
        GROUP BY ve.ledger_account_id
      `);
    } catch {
      return db.execute<RawQueryRow<LedgerBalanceRow>>(sql`
        SELECT
          ve.ledger_account_id,
          SUM(CAST(ve.debit_amount AS numeric)) AS total_debit,
          SUM(CAST(ve.credit_amount AS numeric)) AS total_credit
        FROM voucher_entries ve
        INNER JOIN vouchers v ON ve.voucher_id = v.id
        INNER JOIN ledger_accounts la ON ve.ledger_account_id = la.id
        WHERE la.company_id = ${companyId}
          AND v.optional = false
          AND v.deleted_at IS NULL
          AND v.voucher_date <= ${toDate}
        GROUP BY ve.ledger_account_id
      `);
    }
  };

  const loadPartyBalances = async () => {
    try {
      return await db.execute<RawQueryRow<PartyBalanceRow>>(sql`
        SELECT
          ve.supplier_id,
          ve.employee_id,
          SUM(
            CASE
              WHEN ve.supplier_id IS NOT NULL THEN
                CASE
                  WHEN COALESCE(ve.base_debit_amount, ve.debit_amount)::numeric > 0
                   AND COALESCE(ve.base_credit_amount, ve.credit_amount)::numeric = 0
                  THEN COALESCE(ve.base_debit_amount, ve.debit_amount)::numeric
                  ELSE 0
                END
              ELSE COALESCE(ve.base_debit_amount, ve.debit_amount)::numeric
            END
          ) AS total_debit,
          SUM(
            CASE
              WHEN ve.supplier_id IS NOT NULL THEN
                CASE
                  WHEN COALESCE(ve.base_credit_amount, ve.credit_amount)::numeric > 0
                   AND COALESCE(ve.base_debit_amount, ve.debit_amount)::numeric = 0
                  THEN COALESCE(ve.base_credit_amount, ve.credit_amount)::numeric
                  ELSE 0
                END
              ELSE COALESCE(ve.base_credit_amount, ve.credit_amount)::numeric
            END
          ) AS total_credit
        FROM voucher_entries ve
        INNER JOIN vouchers v ON ve.voucher_id = v.id
        WHERE v.company_id = ${companyId}
          AND v.optional = false
          AND v.deleted_at IS NULL
          AND v.voucher_date <= ${toDate}
          AND (ve.supplier_id IS NOT NULL OR ve.employee_id IS NOT NULL)
        GROUP BY ve.supplier_id, ve.employee_id
      `);
    } catch {
      return db.execute<RawQueryRow<PartyBalanceRow>>(sql`
        SELECT
          ve.supplier_id,
          ve.employee_id,
          SUM(
            CASE
              WHEN ve.supplier_id IS NOT NULL THEN
                CASE
                  WHEN ve.debit_amount::numeric > 0 AND ve.credit_amount::numeric = 0
                  THEN ve.debit_amount::numeric
                  ELSE 0
                END
              ELSE ve.debit_amount::numeric
            END
          ) AS total_debit,
          SUM(
            CASE
              WHEN ve.supplier_id IS NOT NULL THEN
                CASE
                  WHEN ve.credit_amount::numeric > 0 AND ve.debit_amount::numeric = 0
                  THEN ve.credit_amount::numeric
                  ELSE 0
                END
              ELSE ve.credit_amount::numeric
            END
          ) AS total_credit
        FROM voucher_entries ve
        INNER JOIN vouchers v ON ve.voucher_id = v.id
        WHERE v.company_id = ${companyId}
          AND v.optional = false
          AND v.deleted_at IS NULL
          AND v.voucher_date <= ${toDate}
          AND (ve.supplier_id IS NOT NULL OR ve.employee_id IS NOT NULL)
        GROUP BY ve.supplier_id, ve.employee_id
      `);
    }
  };

  const [acctGrouped, suppGrouped] = await Promise.all([loadAccountBalances(), loadPartyBalances()]);

  const accountBalances = new Map<number, { debit: number; credit: number }>();
  const supplierBalances = new Map<number, { debit: number; credit: number }>();
  const employeeBalances = new Map<number, { debit: number; credit: number }>();

  for (const row of acctGrouped.rows) {
    const { debit, credit } = groupedAmounts(row);
    const id = toPositiveInteger(row.ledger_account_id);
    if (id !== undefined) {
      const cur = accountBalances.get(id) || { debit: 0, credit: 0 };
      accountBalances.set(id, { debit: cur.debit + debit, credit: cur.credit + credit });
    }
  }
  for (const row of suppGrouped.rows) {
    const { debit, credit } = groupedAmounts(row);
    const supplierId = toPositiveInteger(row.supplier_id);
    if (supplierId !== undefined) {
      const cur = supplierBalances.get(supplierId) || { debit: 0, credit: 0 };
      supplierBalances.set(supplierId, { debit: cur.debit + debit, credit: cur.credit + credit });
    }
    const employeeId = toPositiveInteger(row.employee_id);
    if (employeeId !== undefined) {
      const cur = employeeBalances.get(employeeId) || { debit: 0, credit: 0 };
      employeeBalances.set(employeeId, { debit: cur.debit + debit, credit: cur.credit + credit });
    }
  }

  // Match the live dashboard: supplier balances are delegated only by an
  // explicit per-company parent link. A standalone ERP company still owns and
  // reports its suppliers even when some unrelated global parent exists.
  const shouldIncludeSuppliers = companyRow?.parentCompanyId == null;
  const supplierPartnerCustomerPosition = isSupplierPartner
    ? await getSupplierPartnerCustomerNetPosition(companyId, toDate)
    : null;

  // SP formula: What We Have = Cash + Customer A/R + SP-HADI-IC receivable (Hadi holds the cash on SP's behalf);
  // What We Owe = Supplier Cash Payable plus Loan/Loans balances.
  // sp_hadi_intercompany is included so that when cash is transferred to Hadi via interco POS
  // transfer, the receivable offsets the supplier payable and Net Position stays at 0.
  // All other SP ledger accounts (OTW, prepaid, clearing, etc.) are excluded.
  // For non-SP companies, the generic exclusion of internal sp_stock / sp_cost_clearing applies.
  const accountsForClassify = isSupplierPartner
    ? companyAccounts.filter(
        (a) =>
          a.accountType === "Cash" ||
          a.accountType === "Loan" ||
          a.accountType === "Loans" ||
          ((a.accountType === "Customer" ||
            a.subType === "Accounts Receivable" ||
            (a.code || "").toUpperCase().startsWith("CUST-") ||
            (a.name || "").toLowerCase().includes("customer account")) &&
            !supplierPartnerCustomerPosition?.ledgerAccountIds.has(a.id)) ||
          a.subType === "sp_payable" ||
          a.subType === "sp_hadi_intercompany"
      )
    : companyAccounts.filter((a) => a.subType !== "sp_stock" && a.subType !== "sp_cost_clearing");
  const classified = classifyNetPositionAccounts(accountsForClassify, accountBalances, {
    includeSupplierTypeAccounts: shouldIncludeSuppliers,
  });
  const equity = classifyEquityAccounts(companyAccounts, accountBalances);

  let forUsTotal = classified.forUsTotal;
  let onUsTotal = classified.onUsTotal;

  const forUsLines: NetPositionLineItem[] = classified.forUsAccounts.map((a) => ({
    label: a.name,
    value: round2(a.value),
    category: a.category,
    side: "forUs",
  }));
  const onUsLines: NetPositionLineItem[] = classified.onUsAccounts.map((a) => ({
    label: a.name,
    value: round2(a.value),
    category: a.category,
    side: "onUs",
  }));

  if (supplierPartnerCustomerPosition) {
    for (const customer of supplierPartnerCustomerPosition.items) {
      const value = round2(Math.abs(customer.signedBalance));
      if (customer.signedBalance > 0) {
        forUsTotal = round2(forUsTotal + value);
        forUsLines.push({ label: customer.name, value, category: "Asset", side: "forUs" });
      } else {
        onUsTotal = round2(onUsTotal + value);
        onUsLines.push({ label: customer.name, value, category: "Liability", side: "onUs" });
      }
    }
  }

  // ── Stock on floor ────────────────────────────────────────────────────
  const activeLocationsData = await db
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.companyId, companyId), eq(locations.active, true), isNull(locations.deletedAt)))
    .execute();
  const activeLocationIds = activeLocationsData.map((l) => l.id);

  let stockFloorTotal = 0;
  if (activeLocationIds.length > 0) {
    const allHistorical = await Promise.all(
      activeLocationIds.map((locId) => calculateHistoricalLocationInventory(locId, companyId, toDate))
    );
    for (const items of allHistorical) {
      for (const inv of items) {
        const qty = parseFloat(inv.quantity || "0");
        const rate = parseFloat(inv.averageRate || "0");
        // Signed valuation must match the live inventory table. Negative stock
        // is a real position and must reduce Stock In Hand rather than disappear.
        if (qty !== 0) stockFloorTotal += qty * rate;
      }
    }
  }
  stockFloorTotal = round2(stockFloorTotal);
  if (stockFloorTotal !== 0) {
    forUsTotal += stockFloorTotal;
    forUsLines.push({
      label: "Stock In Hand (Inventory)",
      value: stockFloorTotal,
      category: "Inventory",
      side: "forUs",
    });
  }

  // ── Employee advances / liabilities ──────────────────────────────────
  const companyEmployees = await db
    .select({
      id: employees.id,
      openingBalance: employees.openingBalance,
      openingBalanceSide: sql<string>`COALESCE(opening_balance_side, 'Cr')`,
    })
    .from(employees)
    .where(and(eq(employees.companyId, companyId), isNull(employees.deletedAt)))
    .execute();

  // Inactive employees can still carry receivables/payables, so deactivation
  // must not erase an accounting position. Use the same shared sign logic as
  // the live dashboard.
  const managedSalaryAdvances = await loadSalaryAdvanceNetPositionAdjustments(companyId, toDate);
  const employeePosition = computeEmployeeNetPositionWithManagedAdvances(
    companyEmployees,
    employeeBalances,
    managedSalaryAdvances
  );
  const employeeAdvanceTotal = employeePosition.advances;
  const employeeLiabilityTotal = employeePosition.liabilities;
  forUsTotal += employeeAdvanceTotal;
  onUsTotal += employeeLiabilityTotal;
  if (employeeAdvanceTotal > 0) {
    forUsLines.push({
      label: "Employee Advances",
      value: round2(employeeAdvanceTotal),
      category: "Advances",
      side: "forUs",
    });
  }
  if (employeeLiabilityTotal > 0) {
    onUsLines.push({
      label: "Owed to Employees",
      value: round2(employeeLiabilityTotal),
      category: "Payables",
      side: "onUs",
    });
  }

  // ── Supplier balances ─────────────────────────────────────────────────
  if (shouldIncludeSuppliers) {
    const allSuppliers = await db
      .select()
      .from(companyScopedSuppliers)
      .where(and(eq(companyScopedSuppliers.companyId, companyId), isNull(companyScopedSuppliers.deletedAt)))
      .execute();
    let supplierTotal = 0;
    for (const sup of allSuppliers) {
      const balance = supplierBalances.get(sup.id) || { debit: 0, credit: 0 };
      const opening = parseFloat(sup.openingBalance || "0");
      const netBalance = opening + balance.credit - balance.debit;
      if (netBalance > 0) {
        onUsTotal += netBalance;
        supplierTotal += netBalance;
      } else if (netBalance < 0) {
        forUsTotal += Math.abs(netBalance);
        forUsLines.push({
          label: `Supplier Credit: ${sup.legalName}`,
          value: round2(Math.abs(netBalance)),
          category: "Supplier Credits",
          side: "forUs",
        });
      }
    }
    if (supplierTotal > 0) {
      onUsLines.push({ label: "Supplier Payables", value: round2(supplierTotal), category: "Payables", side: "onUs" });
    }
  }

  // ── Stock OTW ─────────────────────────────────────────────────────────
  // SP companies track OTW via their sp_goods_otw ledger account ("Goods On The Way"),
  // so we skip the containers-based calculation to avoid double-counting.
  if (!isSupplierPartner) {
    const otwContainers = await db
      .select({ grandTotal: containers.grandTotal, itemsTotal: containers.itemsTotal })
      .from(containers)
      .where(
        and(
          eq(containers.companyId, companyId),
          lte(containers.importDate, toDate),
          or(isNull(containers.offloadDate), sql`${containers.offloadDate} > ${toDate}`)
        )
      )
      .execute();

    let otwTotal = 0;
    for (const c of otwContainers) {
      otwTotal += parseFloat(c.grandTotal || c.itemsTotal || "0");
    }
    otwTotal = round2(otwTotal);
    if (otwTotal !== 0) {
      forUsTotal += otwTotal;
      forUsLines.push({ label: "Stock On The Way (OTW)", value: otwTotal, category: "In Transit", side: "forUs" });
    }
  }

  forUsTotal = round2(forUsTotal);
  onUsTotal = round2(onUsTotal);
  const equityContribution = isSupplierPartner ? equity.total : 0;
  const netPosition = round2(forUsTotal - onUsTotal + equityContribution);

  return {
    forUsTotal,
    onUsTotal,
    netPosition,
    netPositionLabel: netPosition >= 0 ? "We Have More" : "We Owe More",
    forUsLines,
    onUsLines,
  };
}
