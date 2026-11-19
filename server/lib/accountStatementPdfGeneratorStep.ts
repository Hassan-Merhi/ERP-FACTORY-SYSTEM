// Extracted from ./accountStatementPdfGenerator.ts: a stage of accountStatementPdfGenerator.
import { db } from "../db";
import { storage } from "../storage";
import { ledgerAccounts, bankAccounts, fixedAssets, customers, employees } from "@shared/schema";
import { companyScopedSuppliers } from "@shared/schema/supplierCompanyScope";
import { eq, and } from "drizzle-orm";
import type Decimal from "decimal.js";
import { toMoney } from "./money";
import { getCustomerByLedgerId } from "./factoryCustomerLedger";
import { getPartyBalance } from "../services/accounting/balances/ledgerBalanceEngine";
import { projectCustomerStatementLines } from "../routes/factory/customers-core/heldUnfinalizedCustomerCharges";
import { loadPartyMemoLines, memoTotal } from "../services/accounting/balances/unpostedMemo";
import { StatementAccountNotFoundError, customerStatementEntries } from "./accountStatementPdfGeneratorHelpers";
import type { StatementSourceEntry, StatementPdfOptions } from "./accountStatementPdfGenerator";

export async function accountStatementPdfGeneratorStep({ opts }: { opts: StatementPdfOptions }) {
  const { accountType, accountId, companyId, startDate, endDate, lang = "en" } = opts;

  const translations: Record<
    string,
    {
      accountStatement: string;
      period: string;
      generated: string;
      colDate: string;
      colParticulars: string;
      colDebit: string;
      colCredit: string;
      colBalance: string;
      openingBalance: string;
      periodTotal: string;
      closingBalance: string;
      from: string;
      upTo: string;
      allTime: string;
      dr: string;
      cr: string;
    }
  > = {
    en: {
      accountStatement: "Account Statement",
      period: "Period",
      generated: "Generated",
      colDate: "DATE",
      colParticulars: "PARTICULARS",
      colDebit: "DEBIT",
      colCredit: "CREDIT",
      colBalance: "BALANCE",
      openingBalance: "Opening Balance",
      periodTotal: "Current Period Total",
      closingBalance: "Closing Balance",
      from: "From",
      upTo: "Up to",
      allTime: "All Time",
      dr: "Dr",
      cr: "Cr",
    },
    fr: {
      accountStatement: "Relevé de compte",
      period: "Période",
      generated: "Généré le",
      colDate: "DATE",
      colParticulars: "LIBELLÉ",
      colDebit: "DÉBIT",
      colCredit: "CRÉDIT",
      colBalance: "SOLDE",
      openingBalance: "Solde d'ouverture",
      periodTotal: "Total de la période",
      closingBalance: "Solde de clôture",
      from: "Du",
      upTo: "Au",
      allTime: "Toute la période",
      dr: "Dt",
      cr: "Ct",
    },
    ar: {
      accountStatement: "كشف حساب",
      period: "الفترة",
      generated: "تاريخ الإنشاء",
      colDate: "التاريخ",
      colParticulars: "البيان",
      colDebit: "مدين",
      colCredit: "دائن",
      colBalance: "الرصيد",
      openingBalance: "الرصيد الافتتاحي",
      periodTotal: "مجموع الفترة",
      closingBalance: "الرصيد الختامي",
      from: "من",
      upTo: "حتى",
      allTime: "كل الفترات",
      dr: "مد",
      cr: "دا",
    },
  };
  const t = translations[lang] ?? translations["en"];
  const isRTL = lang === "ar";
  const isSupplier = accountType === "supplier";

  // ── 1. Fetch raw entries ──
  // Wave 18 C: every master is read with the company check (a supplier also
  // when this company posted to it), every list holds this company's vouchers
  // by COALESCE(effective_date, voucher_date) and only the lines the balance
  // engine attributes to the account, so opening + lines foots to the engine.
  let rawEntries: StatementSourceEntry[];
  let accountName: string;

  // A customer, or a ledger account a customer owns, is the customer's ledger
  // statement on the balance engine: the lines the engine attributes to the
  // customer, opened at the engine's period opening.
  let customerOwnerId: number | null = null;
  if (accountType === "customer") {
    customerOwnerId = accountId;
  } else if (accountType === "ledger") {
    const owner = await getCustomerByLedgerId(accountId);
    if (owner && owner.companyId === companyId) customerOwnerId = owner.id;
  }

  if (accountType === "ledger") {
    const [acct] = await db
      .select({ name: ledgerAccounts.name })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.id, accountId), eq(ledgerAccounts.companyId, companyId)));
    if (!acct) throw new StatementAccountNotFoundError(accountType, accountId);
    accountName = acct.name ?? "Ledger Account";
    rawEntries = customerOwnerId
      ? await customerStatementEntries(companyId, customerOwnerId, startDate, endDate)
      : await storage.getVoucherEntriesByLedger(accountId, startDate, endDate, companyId);
  } else if (accountType === "bank") {
    const [acct] = await db
      .select({ name: bankAccounts.name })
      .from(bankAccounts)
      .where(and(eq(bankAccounts.id, accountId), eq(bankAccounts.companyId, companyId)));
    if (!acct) throw new StatementAccountNotFoundError(accountType, accountId);
    accountName = acct.name ?? "Bank Account";
    rawEntries = await storage.getVoucherEntriesByBankAccount(accountId, startDate, endDate, companyId, {
      ownedOnly: true,
    });
  } else if (accountType === "fixed-asset") {
    const [acct] = await db
      .select({ name: fixedAssets.name })
      .from(fixedAssets)
      .where(and(eq(fixedAssets.id, accountId), eq(fixedAssets.companyId, companyId)));
    if (!acct) throw new StatementAccountNotFoundError(accountType, accountId);
    accountName = acct.name ?? "Fixed Asset";
    rawEntries = await storage.getVoucherEntriesByFixedAsset(accountId, startDate, endDate, companyId, {
      ownedOnly: true,
    });
  } else if (accountType === "supplier") {
    const [acct] = await db
      .select({ legalName: companyScopedSuppliers.legalName, companyId: companyScopedSuppliers.companyId })
      .from(companyScopedSuppliers)
      .where(eq(companyScopedSuppliers.id, accountId));
    // A supplier of another company is shown only when this company posted to it.
    const postedHere =
      acct && acct.companyId && acct.companyId !== companyId
        ? (await getPartyBalance(db, { companyId, kind: "supplier", id: accountId })) !== null
        : true;
    if (!acct || !postedHere) throw new StatementAccountNotFoundError(accountType, accountId);
    accountName = acct.legalName ?? "Supplier";
    rawEntries = await storage.getVoucherEntriesBySupplier(accountId, companyId, startDate, endDate, {
      ownedOnly: true,
    });
  } else if (accountType === "employee") {
    const [acct] = await db
      .select({ firstName: employees.firstName, lastName: employees.lastName })
      .from(employees)
      .where(and(eq(employees.id, accountId), eq(employees.companyId, companyId)));
    if (!acct) throw new StatementAccountNotFoundError(accountType, accountId);
    accountName = `${acct.firstName} ${acct.lastName}`;
    rawEntries = await storage.getVoucherEntriesByEmployee(accountId, companyId, startDate, endDate, {
      ownedOnly: true,
    });
  } else if (accountType === "customer") {
    const [acct] = await db
      .select({ legalName: customers.legalName })
      .from(customers)
      .where(and(eq(customers.id, accountId), eq(customers.companyId, companyId)));
    if (!acct) throw new StatementAccountNotFoundError(accountType, accountId);
    accountName = acct.legalName ?? "Customer";
    rawEntries = await customerStatementEntries(companyId, accountId, startDate, endDate);
  } else {
    throw new Error(`Unknown account type: ${accountType}`);
  }

  // ── 2. Opening balance: the balance engine's period opening ──
  // The master's opening with the engine's side rule (a sideless opening takes
  // its account type's usual side: a ledger by its type, an employee or
  // supplier Cr, a bank, fixed asset or customer Dr) plus the lines the engine
  // attributes to the account before startDate — the on-screen statement's
  // pre-period balance. Suppliers run Cr positive, every other family Dr.
  const engineKind = customerOwnerId
    ? "customer"
    : (
        {
          ledger: "ledger",
          bank: "bank",
          "fixed-asset": "fixedAsset",
          supplier: "supplier",
          employee: "employee",
        } as const
      )[accountType as "ledger" | "bank" | "fixed-asset" | "supplier" | "employee"];
  const party = await getPartyBalance(db, {
    companyId,
    kind: engineKind,
    id: customerOwnerId ?? accountId,
    from: startDate ?? null,
  });
  const engineOpening = toMoney(party?.opening);
  // Use the same combined receivable as Factory Parties: historic invoices
  // remain operational statement rows, not duplicate GL vouchers.
  const historicalMemo =
    customerOwnerId !== null
      ? ((
          await loadPartyMemoLines(db, {
            companyId,
            kind: "customer",
            ids: [customerOwnerId],
            asOf: endDate ?? null,
          })
        ).get(customerOwnerId) ?? [])
      : [];
  const openingMemo = startDate ? memoTotal(historicalMemo, startDate) : toMoney(0);
  const heldBefore =
    customerOwnerId !== null && startDate
      ? (await projectCustomerStatementLines(companyId, customerOwnerId, [], startDate, endDate)).heldBefore
      : toMoney(0);
  const openingBalanceExact: Decimal = (isSupplier ? engineOpening.negated() : engineOpening)
    .plus(openingMemo)
    .minus(heldBefore);

  const openingBalance = openingBalanceExact.toNumber();

  return {
    companyId,
    startDate,
    endDate,
    t,
    isRTL,
    isSupplier,
    rawEntries,
    accountName,
    historicalMemo,
    openingBalanceExact,
    openingBalance,
  };
}
