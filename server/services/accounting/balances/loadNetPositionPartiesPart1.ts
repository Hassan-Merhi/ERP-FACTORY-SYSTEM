// Extracted from ./netPositionParties.ts
import { sql } from "drizzle-orm";
import { db } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { loadSalaryAdvanceNetPositionAdjustments } from "../../../helpers/salaryAdvanceNetPosition";
import {
  getPartyBalances,
  loadBalanceRows,
  toPartyBalance,
  type PartyBalance,
  type PartyBalanceKind,
} from "./ledgerBalanceEngine";
import { type PartyBalanceMemoLine } from "./unpostedMemo";
import {
  MISSING_ACCOUNT_CATEGORY,
  round2,
  netPositionPartyValue,
  groupMemo,
  employeeTypes,
  type NetPositionPartyLine,
  type NotInLedgerLine,
  type NetPositionPartyOptions,
} from "./netPositionPartiesHelpers";

export async function loadNetPositionPartiesPart1(companyId: number, options: NetPositionPartyOptions) {
  const { asOf, codes } = options;
  const forUs: NetPositionPartyLine[] = [];
  const onUs: NetPositionPartyLine[] = [];
  const memo: NotInLedgerLine[] = [];
  const customerLedgerIds = new Set<number>();
  let payrollSigned = 0;

  const query = (kind: PartyBalanceKind, withMemo = false) =>
    getPartyBalances(db, { companyId, kind, asOf, memo: withMemo });

  const [customerResult, supplierResult, factorySupplierResult, employeeResult, bankResult, missingRows] =
    await Promise.all([
      query("customer", options.customers),
      options.suppliers ? query("supplier") : null,
      options.factorySuppliers ? query("factorySupplier", true) : null,
      options.employees ? query("employee") : null,
      options.banks ? query("bank") : null,
      options.missingAccounts ? loadBalanceRows(db, { companyId, asOf, kind: "missingAccount" }) : null,
    ]);

  for (const row of missingRows ?? []) {
    const party = toPartyBalance(row);
    const value = round2(netPositionPartyValue(party));
    if (Math.abs(value) < 0.01) continue;
    const base = {
      name: party.name,
      code: `MISSING_ACCOUNT_${party.id ?? ""}`,
      category: MISSING_ACCOUNT_CATEGORY,
      partyKind: "missingAccount" as const,
      partyId: party.id,
    };
    if (value > 0) forUs.push({ ...base, value });
    else onUs.push({ ...base, value: -value });
  }

  // Customer-owned ledgers are always left out of the ledger classification:
  // the engine rolls them into the customer (supplier-partner companies
  // exclude customers altogether, by design).
  for (const party of customerResult.parties) {
    if (party.linkedLedgerAccountId !== null) customerLedgerIds.add(party.linkedLedgerAccountId);
  }

  if (options.customers) {
    const memoLines: PartyBalanceMemoLine[] = [];
    for (const party of customerResult.parties) {
      memoLines.push(...party.memoLines);
      const value = round2(netPositionPartyValue(party));
      if (Math.abs(value) < 0.01) continue;
      const base = {
        ...(party.linkedLedgerAccountId !== null ? { id: party.linkedLedgerAccountId } : {}),
        name: party.name,
        category: "Customer",
        partyKind: "customer" as const,
        partyId: party.id,
      };
      if (value > 0) forUs.push({ ...base, code: codes === "factory" ? "CUSTOMER_DR" : (party.code ?? ""), value });
      else onUs.push({ ...base, code: codes === "factory" ? "CUSTOMER_CR" : (party.code ?? ""), value: -value });
    }
    memo.push(...groupMemo(memoLines));
  }

  if (bankResult) {
    // Presented like a Cash/Bank ledger account in classifyNetPositionAccounts:
    // a debit balance is an asset, a credit (overdrawn) balance a liability.
    for (const party of bankResult.parties) {
      const value = round2(netPositionPartyValue(party));
      if (Math.abs(value) < 0.01 || party.id === null) continue;
      const base = {
        name: party.name,
        code: party.code ?? "",
        category: "Bank",
        partyKind: "bank" as const,
        partyId: party.id,
        bankAccountId: party.id,
      };
      if (value > 0) forUs.push({ ...base, value });
      else onUs.push({ ...base, value: -value });
    }
  }

  if (supplierResult) {
    // A supplier of another company this company posted to (owner decision 2)
    // has no master row here: show it under its own name and code.
    const sharedIds = supplierResult.parties
      .filter((party) => party.id !== null && party.code === null)
      .map((party) => party.id as number);
    const sharedMasters = new Map<number, { name: string; code: string }>();
    if (sharedIds.length > 0) {
      const rows = await db.execute<{ id: number; legal_name: string; code: string }>(
        sql`SELECT id, legal_name, code FROM suppliers WHERE id IN (${sql.join(
          sharedIds.map((id) => sql`${id}`),
          sql`, `
        )})`
      );
      for (const row of rows.rows) sharedMasters.set(Number(row.id), { name: row.legal_name, code: row.code });
    }
    for (const party of supplierResult.parties) {
      const owed = round2(-netPositionPartyValue(party));
      if (Math.abs(owed) < 0.01) continue;
      const shared = party.id !== null ? sharedMasters.get(party.id) : undefined;
      const base = {
        name: shared?.name ?? party.name,
        code: shared?.code ?? party.code ?? "",
        partyKind: "supplier" as const,
        partyId: party.id,
      };
      if (owed > 0) onUs.push({ ...base, value: owed, category: "Supplier" });
      else forUs.push({ ...base, value: -owed, category: "Supplier Overpayment" });
    }
  }

  if (factorySupplierResult) {
    const memoLines: PartyBalanceMemoLine[] = [];
    for (const party of factorySupplierResult.parties) {
      memoLines.push(...party.memoLines);
      const owed = round2(-netPositionPartyValue(party));
      if (Math.abs(owed) < 0.01) continue;
      const base = { name: party.name, partyKind: "factorySupplier" as const, partyId: party.id };
      if (owed > 0) onUs.push({ ...base, code: "SUPPLIER", value: owed, category: "Supplier" });
      else forUs.push({ ...base, code: "SUPPLIER_OVERPAID", value: -owed, category: "Supplier Overpayments" });
    }
    memo.push(...groupMemo(memoLines));
  }

  if (employeeResult) {
    const ids = employeeResult.parties.map((party) => party.id).filter((id): id is number => id !== null);
    const types = await employeeTypes(companyId, ids);
    const isWorker = (party: PartyBalance) => party.id !== null && types.get(party.id)?.type === "Worker";
    let payrollDr = new MoneyDecimal(0);
    let workersDr = new MoneyDecimal(0);
    let currentBalanceCr = new MoneyDecimal(0);
    let employeesDr = new MoneyDecimal(0);
    for (const party of employeeResult.parties) {
      const value = toMoney(party.historicalBaseClosing);
      if (isWorker(party)) {
        workersDr = workersDr.plus(value);
        continue;
      }
      employeesDr = employeesDr.plus(value);
      if (party.id !== null) currentBalanceCr = currentBalanceCr.plus(toMoney(types.get(party.id)?.currentBalance));
      if (options.employees === "factory") {
        // Factory: each employee who owes us is listed; the rest is Payroll Payable.
        const v = round2(value.toNumber());
        if (v > 0) {
          forUs.push({
            name: party.name,
            code: "EMPLOYEE_RECEIVABLE",
            value: v,
            category: "Employee Receivable",
            partyKind: "employee",
            partyId: party.id,
          });
        } else if (v < 0) {
          payrollDr = payrollDr.plus(value);
        }
      } else {
        const payrollBalance = round2(toMoney(types.get(party.id!)?.currentBalance).toNumber());
        if (payrollBalance > 0) {
          onUs.push({
            name: party.name,
            code: "PAYROLL_EMPLOYEE",
            value: payrollBalance,
            category: "Payroll",
            partyKind: "employee",
            partyId: party.id,
          });
        } else if (payrollBalance < 0) {
          forUs.push({
            name: party.name,
            code: "EMPLOYEE_RECEIVABLE",
            value: -payrollBalance,
            category: "Employee Receivable",
            partyKind: "employee",
            partyId: party.id,
          });
        }
        payrollDr = payrollDr.minus(payrollBalance);
      }
    }
    payrollSigned = round2(payrollDr.negated().toNumber());
    const payrollCode = codes === "factory" ? "EMPLOYEE_PAYROLL_PAYABLE" : "PAYROLL_PAYABLE";
    const payrollCategory = codes === "factory" ? "Liability" : "Payroll";
    if (options.employees === "factory" && (payrollSigned > 0 || codes === "factory")) {
      onUs.push({
        name: "Payroll Payable",
        code: payrollCode,
        value: Math.max(0, payrollSigned),
        category: payrollCategory,
        partyKind: "employee",
        partyId: null,
      });
    }
    if (options.employees === "factory" && payrollSigned < 0) {
      forUs.push({
        name: "Payroll Overpayment",
        code: payrollCode,
        value: -payrollSigned,
        category: "Payroll",
        partyKind: "employee",
        partyId: null,
      });
    }
    // ERP Payroll's Advances tab is the authoritative current outstanding balance:
    // only unpaid salary advances contribute their remaining balance. Do not use the
    // worker subledger here, which can include unrelated worker transactions.
    const workers =
      options.employees === "erp" && !asOf
        ? round2(
            Number(
              (
                await db.execute(sql`
          SELECT COALESCE(SUM(remaining_balance::numeric), 0) AS outstanding
          FROM salary_advances
          WHERE company_id = ${companyId} AND fully_paid = false
        `)
              ).rows[0]?.outstanding ?? 0
            )
          )
        : round2(workersDr.toNumber());
    if (workers > 0) {
      forUs.push({
        name: "Worker Advances (Prepaid)",
        code: "WORKER_LEDGER",
        value: workers,
        category: "Worker Advances",
        partyKind: "employee",
        partyId: null,
      });
    } else if (workers < 0) {
      onUs.push({
        name: "Workers Payable",
        code: "WORKER_LEDGER",
        value: -workers,
        category: "Payroll",
        partyKind: "employee",
        partyId: null,
      });
    }

    // The salary-advance table's remaining balance over what the ledger holds
    // for the same advances (the old reports replaced the posted debit by it).
    const managed = await loadSalaryAdvanceNetPositionAdjustments(companyId, asOf);
    const advanceDelta = round2(managed.reduce((sum, a) => sum + a.remainingBalance - a.postedDebit, 0));
    if (advanceDelta !== 0) {
      memo.push({
        label: "Salary advances: advances-table remaining balance differs from the ledger",
        code: "NOT_IN_LEDGER_SALARY_ADVANCES",
        value: advanceDelta,
        category: "Not yet in the ledger",
        count: managed.length,
      });
    }
    if (options.payrollCurrentBalanceMemo) {
      // employees.current_balance is Cr positive (we owe them); the ledger's
      // Employees net, Cr positive, is −employeesDr.
      const delta = round2(currentBalanceCr.plus(employeesDr).toNumber());
      if (delta !== 0) {
        memo.push({
          label: "Payroll: the payroll page's current balance differs from the ledger",
          code: "NOT_IN_LEDGER_PAYROLL_CURRENT_BALANCE",
          value: -delta,
          category: "Not yet in the ledger",
          count: 0,
        });
      }
    }
  }
  return { forUs, onUs, memo, customerLedgerIds, payrollSigned };
}
