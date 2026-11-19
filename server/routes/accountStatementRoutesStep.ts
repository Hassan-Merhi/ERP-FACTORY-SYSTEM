// Extracted from ./accountStatementRoutes.ts: a stage of accountStatementRoutes.
import { statementDateKey, validateStatementDateRange } from "../lib/accountStatementExportSafety";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { MoneyDecimal, toMoney } from "../lib/money";
import { storage } from "../storage";
import { getPartyBalance } from "../services/accounting/balances/ledgerBalanceEngine";
import { loadCustomerLedgerEntryRows } from "../services/accounting/balances/customerLedgerStatement";
import { getCustomerByLedgerId } from "../lib/factoryCustomerLedger";
import { projectCustomerStatementLines } from "./factory/customers-core/heldUnfinalizedCustomerCharges";
import { projectExportCurrencyRow } from "../services/accounting/exportCurrency";
import { bankAccounts, companies, employees, fixedAssets, ledgerAccounts } from "@shared/schema";
import type { AccountStatementEntryRow } from "../storage/accounting/vouchers";
import { companyScopedSuppliers } from "@shared/schema/supplierCompanyScope";
import type { Request, Response } from "express";

export async function accountStatementRoutesStep({ req, res }: { req: Request; res: Response }) {
  const companyId = req.session.currentCompanyId as number;
  if (!companyId) return { done: true as const, value: res.status(400).json({ message: "No company selected" }) };

  const accountTypeRaw = req.query.accountType;
  const accountIdRaw = req.query.accountId;
  const startDateRaw = req.query.startDate;
  const endDateRaw = req.query.endDate;
  if (accountTypeRaw !== undefined && typeof accountTypeRaw !== "string") {
    return {
      done: true as const,
      value: res.status(400).json({ message: "accountType must be a single string value" }),
    };
  }
  if (typeof accountIdRaw !== "string") {
    return { done: true as const, value: res.status(400).json({ message: "Invalid accountId" }) };
  }
  if (startDateRaw !== undefined && typeof startDateRaw !== "string") {
    return {
      done: true as const,
      value: res.status(400).json({ message: "startDate must be a single YYYY-MM-DD value" }),
    };
  }
  if (endDateRaw !== undefined && typeof endDateRaw !== "string") {
    return {
      done: true as const,
      value: res.status(400).json({ message: "endDate must be a single YYYY-MM-DD value" }),
    };
  }

  const accountType = accountTypeRaw || "ledger";
  const accountId = Number.parseInt(accountIdRaw, 10);
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    return { done: true as const, value: res.status(400).json({ message: "Invalid accountId" }) };
  }
  const startDate = startDateRaw;
  const endDate = endDateRaw;
  const dateRange = validateStatementDateRange(startDate, endDate);
  if (!dateRange.ok) return { done: true as const, value: res.status(400).json({ message: dateRange.message }) };

  let accountName = "Account";
  let ownedCustomerId: number | null = null;

  const [company] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId));

  // Wave 18 C: every master is read with the company check, and every
  // family opens at the balance engine's period opening (the on-screen
  // statement's pre-period balance): the master's opening with the
  // engine's side rule (sideless by account type) plus the lines the engine
  // attributes to it before startDate, in this company's vouchers, by
  // COALESCE(effective_date, voucher_date). Bank, fixed-asset and employee
  // exports carry that opening forward (they opened at zero).
  if (accountType === "ledger") {
    const [acct] = await db
      .select({ name: ledgerAccounts.name })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.id, accountId), eq(ledgerAccounts.companyId, companyId)));
    if (!acct) return { done: true as const, value: res.status(404).json({ message: "Account not found" }) };
    accountName = acct.name;
    // A ledger a customer owns exports that customer's ledger statement
    // (balance engine lines and the customer-owned opening).
    const owner = await getCustomerByLedgerId(accountId);
    if (owner && owner.companyId === companyId) ownedCustomerId = owner.id;
  } else if (accountType === "bank") {
    const [acct] = await db
      .select({ name: bankAccounts.name })
      .from(bankAccounts)
      .where(and(eq(bankAccounts.id, accountId), eq(bankAccounts.companyId, companyId)));
    if (!acct) return { done: true as const, value: res.status(404).json({ message: "Bank account not found" }) };
    accountName = acct.name;
  } else if (accountType === "fixed-asset") {
    const [acct] = await db
      .select({ name: fixedAssets.name })
      .from(fixedAssets)
      .where(and(eq(fixedAssets.id, accountId), eq(fixedAssets.companyId, companyId)));
    if (!acct) return { done: true as const, value: res.status(404).json({ message: "Fixed asset not found" }) };
    accountName = acct.name;
  } else if (accountType === "supplier") {
    const [acct] = await db
      .select({ name: companyScopedSuppliers.legalName, companyId: companyScopedSuppliers.companyId })
      .from(companyScopedSuppliers)
      .where(eq(companyScopedSuppliers.id, accountId));
    // A supplier of another company is exported only when this company posted to it.
    const postedHere =
      acct && acct.companyId && acct.companyId !== companyId
        ? (await getPartyBalance(db, { companyId, kind: "supplier", id: accountId })) !== null
        : true;
    if (!acct || !postedHere)
      return { done: true as const, value: res.status(404).json({ message: "Supplier not found" }) };
    accountName = acct.name ?? "Supplier";
  } else if (accountType === "employee") {
    const [acct] = await db
      .select({ firstName: employees.firstName, lastName: employees.lastName })
      .from(employees)
      .where(and(eq(employees.id, accountId), eq(employees.companyId, companyId)));
    if (!acct) return { done: true as const, value: res.status(404).json({ message: "Employee not found" }) };
    accountName = `${acct.firstName} ${acct.lastName}`.trim();
  }

  const engineKind =
    ownedCustomerId !== null
      ? ("customer" as const)
      : (
          {
            ledger: "ledger",
            bank: "bank",
            "fixed-asset": "fixedAsset",
            supplier: "supplier",
            employee: "employee",
          } as const
        )[accountType as "ledger" | "bank" | "fixed-asset" | "supplier" | "employee"];
  const party = engineKind
    ? await getPartyBalance(db, {
        companyId,
        kind: engineKind,
        id: ownedCustomerId ?? accountId,
        from: startDate ?? null,
        asOf: endDate ?? null,
      })
    : null;
  // Dr positive (the worksheet's balance column).
  const masterOpening = toMoney(party?.masterOpening);
  const openingBalanceExact = masterOpening.abs();
  const openingBalanceSide: "Cr" | "Dr" = masterOpening.isNegative() ? "Cr" : "Dr";

  let txRows: AccountStatementEntryRow[] = [];
  let heldBeforeExport = new MoneyDecimal(0);
  if (ownedCustomerId !== null) {
    txRows = await loadCustomerLedgerEntryRows(db, {
      companyId,
      customerId: ownedCustomerId,
      from: startDate ?? null,
      to: endDate ?? null,
    });
    const projected = await projectCustomerStatementLines(
      companyId,
      ownedCustomerId,
      txRows,
      startDate ?? null,
      endDate ?? null
    );
    txRows = projected.rows;
    heldBeforeExport = projected.heldBefore;
  } else if (accountType === "ledger") {
    txRows = await storage.getVoucherEntriesByLedger(accountId, startDate, endDate, companyId);
  } else if (accountType === "bank") {
    txRows = await storage.getVoucherEntriesByBankAccount(accountId, startDate, endDate, companyId, {
      ownedOnly: true,
    });
  } else if (accountType === "fixed-asset") {
    txRows = await storage.getVoucherEntriesByFixedAsset(accountId, startDate, endDate, companyId, {
      ownedOnly: true,
    });
  } else if (accountType === "supplier") {
    txRows = await storage.getVoucherEntriesBySupplier(accountId, companyId, startDate, endDate, {
      ownedOnly: true,
    });
  } else if (accountType === "employee") {
    txRows = await storage.getVoucherEntriesByEmployee(accountId, companyId, startDate, endDate, {
      ownedOnly: true,
    });
  }
  // The supplier and employee lists come newest first; the running balance needs them in date order.
  txRows = [...txRows].sort(
    (x, y) =>
      (statementDateKey(x.voucherDate) ?? "").localeCompare(statementDateKey(y.voucherDate) ?? "") ||
      Number(x.voucherId) - Number(y.voucherId)
  );

  // Balances are kept exact and become numbers only for the worksheet cells.
  const openingBalance = openingBalanceExact.toNumber();
  const signedOpening = masterOpening;
  // Brought forward: the engine's period opening (masterOpening without a start date).
  const bfExact = toMoney(party?.opening).minus(heldBeforeExport);
  const bfBalance = bfExact.toNumber();

  let runExact = startDate ? bfExact : signedOpening;
  let totalDrExact = new MoneyDecimal(0);
  let totalCrExact = new MoneyDecimal(0);
  const enrichedRows = txRows.map((r) => {
    const projected = projectExportCurrencyRow(r as Record<string, unknown>);
    // Employee Excel must foot to the on-screen employee ledger. The
    // balance engine and statement use posted debit/credit amounts, not
    // a separate FX projection that can restate the exported closing.
    const drExact = accountType === "employee" ? toMoney(r.debitAmount) : toMoney(projected.historicalBaseDebit);
    const crExact = accountType === "employee" ? toMoney(r.creditAmount) : toMoney(projected.historicalBaseCredit);
    runExact = runExact.plus(drExact).minus(crExact);
    totalDrExact = totalDrExact.plus(drExact);
    totalCrExact = totalCrExact.plus(crExact);
    return { ...r, dr: drExact.toNumber(), cr: crExact.toNumber(), runBal: runExact.toNumber(), projected };
  });

  const totalDr = totalDrExact.toNumber();
  const totalCr = totalCrExact.toNumber();
  const closingRaw = runExact.toNumber();
  const closingBalance2 = Math.abs(closingRaw);
  const closingBalanceSide2: "Dr" | "Cr" = closingRaw >= 0 ? "Dr" : "Cr";

  const numFmt = "#,##0.00";
  const navyFill = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FF1F3864" } };
  const lightBlueFill = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFEFF3FB" } };
  const greyFill = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFF5F5F5" } };
  const allBorders = {
    top: { style: "thin" as const },
    bottom: { style: "thin" as const },
    left: { style: "thin" as const },
    right: { style: "thin" as const },
  };

  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Business OS";
  workbook.created = new Date();
  workbook.modified = new Date();
  const sheet = workbook.addWorksheet("Statement", {
    properties: { defaultRowHeight: 18 },
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
  });
  sheet.pageSetup.margins = {
    left: 0.25,
    right: 0.25,
    top: 0.5,
    bottom: 0.5,
    header: 0.2,
    footer: 0.2,
  };

  return {
    done: false as const,
    accountType,
    startDate,
    endDate,
    accountName,
    company,
    openingBalanceSide,
    txRows,
    openingBalance,
    bfExact,
    bfBalance,
    enrichedRows,
    totalDr,
    totalCr,
    closingBalance2,
    closingBalanceSide2,
    numFmt,
    navyFill,
    lightBlueFill,
    greyFill,
    allBorders,
    workbook,
    sheet,
  };
}
