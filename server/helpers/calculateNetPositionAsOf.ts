/**
 * Shared helper: calculate the ERP net position as of a specific date.
 *
 * Returns the four summary values PLUS a full breakdown of every line item
 * on both sides (What We Have / What We Owe) so callers can build detailed
 * per-month sheets.
 */

import { db, type RawQueryRow } from "../db";
import { storage } from "../storage";
import { locations, employees, suppliers, containers } from "@shared/schema";
import { eq, and, or, isNull, lte, sql } from "drizzle-orm";
import { classifyEquityAccounts, classifyNetPositionAccounts, round2 } from "../netPositionHelper";
import { calculateHistoricalLocationInventory } from "../routes/_helpers";
import { getSupplierPartnerCustomerNetPosition } from "./supplierPartnerCustomerNetPosition";
import { toFiniteNumber, toPositiveInteger } from "@shared/typeGuards";

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
  const [acctGrouped, suppGrouped] = await Promise.all([
    db.execute<RawQueryRow<LedgerBalanceRow>>(sql`
      SELECT
        ve.ledger_account_id,
        SUM(CAST(ve.debit_amount  AS numeric)) AS total_debit,
        SUM(CAST(ve.credit_amount AS numeric)) AS total_credit
      FROM voucher_entries ve
      INNER JOIN vouchers v ON ve.voucher_id = v.id
      INNER JOIN ledger_accounts la ON ve.ledger_account_id = la.id
      WHERE la.company_id   = ${companyId}
        AND v.optional      = false
        AND v.deleted_at    IS NULL
        AND v.voucher_date <= ${toDate}
      GROUP BY ve.ledger_account_id
    `),
    db.execute<RawQueryRow<PartyBalanceRow>>(sql`
      SELECT
        ve.supplier_id,
        ve.employee_id,
        SUM(CAST(ve.debit_amount  AS numeric)) AS total_debit,
        SUM(CAST(ve.credit_amount AS numeric)) AS total_credit
      FROM voucher_entries ve
      INNER JOIN vouchers v ON ve.voucher_id = v.id
      WHERE v.company_id    = ${companyId}
        AND v.optional      = false
        AND v.deleted_at    IS NULL
        AND v.voucher_date <= ${toDate}
        AND (ve.supplier_id IS NOT NULL OR ve.employee_id IS NOT NULL)
      GROUP BY ve.supplier_id, ve.employee_id
    `),
  ]);

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

  const parentCompanyId = await storage.getParentCompanyId();
  const shouldIncludeSuppliers = parentCompanyId === null || companyId === parentCompanyId;
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
        if (qty > 0) stockFloorTotal += qty * rate;
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
    .select()
    .from(employees)
    .where(and(eq(employees.companyId, companyId), eq(employees.active, true), isNull(employees.deletedAt)))
    .execute();

  let employeeAdvanceTotal = 0;
  let employeeLiabilityTotal = 0;
  for (const emp of companyEmployees) {
    const opening = parseFloat(emp.openingBalance || "0");
    const openingSide =
      (
        emp as unknown as {
          id: number;
          companyId: number;
          code: string;
          firstName: string;
          lastName: string;
          email: string | null;
          phone: string | null;
          joinDate: string;
          department: string | null;
          employeeType: string;
          monthlySalary: string;
          openingBalance: string | null;
          currentBalance: string;
          totalDeposits: string;
          totalWithdrawals: string;
          active: boolean;
          salesBonusPct: string | null;
          salesBonusPctSourceCompanyId: number | null;
          salesBonusPctLocationId: number | null;
          balesBonusRate: string | null;
          deletedAt: Date | null;
          createdAt: Date;
        } & { openingBalanceSide: "Dr" }
      ).openingBalanceSide === "Dr"
        ? 1
        : -1;
    const signedOpening = opening * openingSide;
    const balance = employeeBalances.get(emp.id) || { debit: 0, credit: 0 };
    const netBalance = signedOpening + balance.debit - balance.credit;
    if (netBalance < 0) {
      onUsTotal += Math.abs(netBalance);
      employeeLiabilityTotal += Math.abs(netBalance);
    } else if (netBalance > 0) {
      forUsTotal += netBalance;
      employeeAdvanceTotal += netBalance;
    }
  }
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
    const allSuppliers = await db.select().from(suppliers).where(isNull(suppliers.deletedAt)).execute();
    let supplierTotal = 0;
    for (const sup of allSuppliers) {
      const balance = supplierBalances.get(sup.id);
      if (balance) {
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
