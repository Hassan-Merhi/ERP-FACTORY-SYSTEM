/**
 * Shared helper: calculate the ERP net position as of a specific date.
 *
 * Returns the four summary values PLUS a full breakdown of every line item
 * on both sides (What We Have / What We Owe) so callers can build detailed
 * per-month sheets.
 */

import { db, type RawQueryRow } from "../db";
import { storage } from "../storage";
import { containers } from "@shared/schema";
import { eq, and, or, isNull, lte, sql } from "drizzle-orm";
import { classifyEquityAccounts, classifyNetPositionAccounts, round2 } from "../netPositionHelper";
import { companyStockValue } from "../services/inventory/stockValuation";
import { loadNetPositionParties, type NotInLedgerSection } from "../services/accounting/balances/netPositionParties";
import { toFiniteNumber, toPositiveInteger } from "@shared/typeGuards";
import { ledgerCarriesStock } from "../services/accounting/perpetualInventory/reportBasis";

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
  /** Amounts not yet in the ledger: shown separately, never part of the totals (wave 10). */
  notInLedger?: NotInLedgerSection;
}

export async function calculateNetPositionAsOf(
  companyId: number,
  toDate: string // YYYY-MM-DD
): Promise<NetPositionSnapshot> {
  const companyAccounts = await storage.getAllLedgerAccounts(companyId, true);
  const companyRow = await storage.getCompanyById(companyId);
  const isSupplierPartner = companyRow?.companyType === "supplier_partner";

  // Ledger accounts: this company's vouchers on its own accounts (engine rule
  // 4, wave 17 A). They were filtered by the ACCOUNT's company_id, so another
  // company's lines on these accounts counted here but not on this company's
  // balance sheet; lines of this company's vouchers on another company's or a
  // missing account are the engine's missingAccount lines. Vouchers count from
  // COALESCE(effective_date, voucher_date), as in the balance engine.
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
          AND v.company_id = ${companyId}
          AND v.optional = false
          AND v.deleted_at IS NULL
          AND COALESCE(v.effective_date, v.voucher_date) <= ${toDate}
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
          AND v.company_id = ${companyId}
          AND v.optional = false
          AND v.deleted_at IS NULL
          AND COALESCE(v.effective_date, v.voucher_date) <= ${toDate}
        GROUP BY ve.ledger_account_id
      `);
    }
  };

  const [acctGrouped, parties] = await Promise.all([
    loadAccountBalances(),
    // Customers, suppliers and employees come from the one balance engine
    // (services/accounting/balances/netPositionParties.ts); supplier-partner
    // companies exclude customers by design.
    loadNetPositionParties(companyId, {
      asOf: toDate,
      customers: !isSupplierPartner,
      suppliers: true, // ERP_NET_POSITION_INCLUDES_SUPPLIERS (netPositionParties.ts)
      factorySuppliers: false,
      employees: "erp",
      codes: "erp",
      banks: true,
      missingAccounts: true,
    }),
  ]);

  const accountBalances = new Map<number, { debit: number; credit: number }>();
  for (const row of acctGrouped.rows) {
    const { debit, credit } = groupedAmounts(row);
    const id = toPositiveInteger(row.ledger_account_id);
    if (id !== undefined) {
      const cur = accountBalances.get(id) || { debit: 0, credit: 0 };
      accountBalances.set(id, { debit: cur.debit + debit, credit: cur.credit + credit });
    }
  }

  // One supplier-inclusion rule (wave 13, owner decision 2), as the live
  // dashboard: supplier payables count in the posting company.
  const shouldIncludeSuppliers = true; // ERP_NET_POSITION_INCLUDES_SUPPLIERS (netPositionParties.ts)

  // SP formula: What We Have = Cash + SP-HADI-IC receivable (Hadi holds the cash on SP's behalf);
  // What We Owe = Supplier Cash Payable plus Loan/Loans balances. Customers are excluded by design.
  // sp_hadi_intercompany is included so that when cash is transferred to Hadi via interco POS
  // transfer, the receivable offsets the supplier payable and Net Position stays at 0.
  // All other SP ledger accounts (OTW, prepaid, clearing, etc.) are excluded.
  // For non-SP companies, the generic exclusion of internal sp_stock / sp_cost_clearing applies.
  // Ledger accounts a customer owns are left out everywhere: the engine rolls them
  // into the customer, whose line comes from loadNetPositionParties.
  const accountsForClassify = (
    isSupplierPartner
      ? companyAccounts.filter(
          (a) =>
            a.accountType === "Cash" ||
            a.accountType === "Loan" ||
            a.accountType === "Loans" ||
            a.subType === "sp_payable" ||
            a.subType === "sp_hadi_intercompany"
        )
      : companyAccounts.filter((a) => a.subType !== "sp_stock" && a.subType !== "sp_cost_clearing")
  ).filter((a) => !parties.customerLedgerIds.has(a.id));
  // Perpetual inventory (wave 8.5): from the cut-over the ledger carries the stock.
  const ledgerStock = !isSupplierPartner && (await ledgerCarriesStock(companyId, toDate));
  const classified = classifyNetPositionAccounts(accountsForClassify, accountBalances, {
    includeSupplierTypeAccounts: shouldIncludeSuppliers,
    ledgerStockAccounts: ledgerStock,
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

  // ── Customers, suppliers, employees and bank accounts (balance engine) ──
  for (const line of parties.forUs) {
    const label = line.partyKind === "supplier" ? `Supplier Credit: ${line.name}` : line.name;
    const category = line.partyKind === "supplier" ? "Supplier Credits" : line.category;
    forUsLines.push({ label, value: line.value, category, side: "forUs" });
  }
  let supplierTotal = 0;
  for (const line of parties.onUs) {
    if (line.partyKind === "supplier") {
      supplierTotal = round2(supplierTotal + line.value);
      continue;
    }
    onUsLines.push({ label: line.name, value: line.value, category: line.category, side: "onUs" });
  }
  if (supplierTotal > 0) {
    onUsLines.push({ label: "Supplier Payables", value: supplierTotal, category: "Payables", side: "onUs" });
  }
  forUsTotal += parties.forUsTotal;
  onUsTotal += parties.onUsTotal;

  // ── Stock on floor ────────────────────────────────────────────────────
  // Wave 11: the one stock valuation (stockValuation): SUM(total_value) as of
  // the date over the company's non-deleted locations, active or inactive,
  // bale mirror left out. Negative stock does not subtract (owner decision);
  // its provisional value is reported by the valuation, not netted here.
  let stockFloorTotal = 0;
  if (!ledgerStock) {
    stockFloorTotal = Number(await companyStockValue(db, companyId, toDate));
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

  // ── Stock OTW ─────────────────────────────────────────────────────────
  // SP companies track OTW via their sp_goods_otw ledger account ("Goods On The Way"),
  // so we skip the containers-based calculation to avoid double-counting.
  // From the cut-over, Goods in Transit in the ledger carries the containers on the way.
  if (!isSupplierPartner && !ledgerStock) {
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
    notInLedger: parties.notInLedger,
  };
}
