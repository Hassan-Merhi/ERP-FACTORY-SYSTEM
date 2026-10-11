/**
 * accountRoutes: AccountList endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth } from "../../auth";
import { getSupplierBalanceForContext, isSupplierVisibleToCompany } from "../helpers/supplierBalanceHelpers";
import { companyScopedSuppliers } from "@shared/schema/supplierCompanyScope";
import { and, sql, isNull, inArray } from "drizzle-orm";
import {
  getPartyBalances,
  loadBalanceRows,
  openingSideOf,
  toPartyBalance,
  type PartyBalance,
} from "../../services/accounting/balances/ledgerBalanceEngine";
import { requireFactoryPageAccess } from "../../lib/factoryAccessControl";
import { getClientDate } from "../../lib/dateUtils";
import { loadPartyOpeningSides } from "../helpers/partyOpeningSide";
import { resultRows } from "../../lib/queryResult";
import { isSystemOnlyLedgerAccount } from "../../lib/systemOnlyLedgerAccounts";
import type Decimal from "decimal.js";
import { MoneyDecimal, toMoney } from "../../lib/money";

export async function serveAccountListForCompany(req: Request, res: Response, companyId: number) {
  try {
    const analyticsProfile = req.query.profile === "analytics";

    // Analytics renders only ledger, bank and fixed-asset balances. Avoid
    // loading employee/supplier account families that would be discarded by
    // the compact profile after all their balance work had already run.
    const [currentCompany, ledgersAll, banks, assets, employees, allSuppliers] = await Promise.all([
      storage.getCompanyById(companyId),
      storage.getAllLedgerAccounts(companyId, true),
      storage.getAllBankAccounts(companyId),
      storage.getAllFixedAssets(companyId),
      analyticsProfile ? Promise.resolve([]) : storage.getAllEmployees(companyId),
      analyticsProfile ? Promise.resolve([]) : storage.getAllSuppliers(),
    ]);
    const ledgers = ledgersAll.filter(
      (a) => !["sp_stock", "sp_opnbal"].includes(a.subType ?? "") && !isSystemOnlyLedgerAccount(a)
    );
    const isFactoryCompany = currentCompany?.companyType === "factory";
    const isPropertiesCompany = currentCompany?.companyType === "properties";
    // getAllSuppliers() is not company-scoped, so foreign tenants' rows have to
    // be dropped here rather than left to the child-company activity filter
    // below, which a company resolving to itself never applies.
    const ownSuppliers =
      isFactoryCompany || isPropertiesCompany
        ? []
        : allSuppliers.filter((supplier) => isSupplierVisibleToCompany(supplier, companyId));
    // Wave 14, one supplier rule (the posting company): a supplier of another
    // company this company posted to is this company's payable too (as on the
    // Suppliers page, wave 13). The engine lists it with no code here.
    const postedElsewhereIds =
      isFactoryCompany || isPropertiesCompany || analyticsProfile
        ? []
        : (await getPartyBalances(db, { companyId, kind: "supplier" })).parties
            .filter((party) => party.id !== null && party.code === null)
            .map((party) => party.id as number)
            .filter((id) => !ownSuppliers.some((supplier) => supplier.id === id));
    const postedElsewhere =
      postedElsewhereIds.length === 0
        ? []
        : await db
            .select()
            .from(companyScopedSuppliers)
            .where(
              and(inArray(companyScopedSuppliers.id, postedElsewhereIds), isNull(companyScopedSuppliers.deletedAt))
            );
    const suppliers = [...ownSuppliers, ...postedElsewhere];

    const [employeeOpeningSides, supplierOpeningSides] = await Promise.all([
      loadPartyOpeningSides(
        "employees",
        employees.map((employee) => employee.id)
      ),
      loadPartyOpeningSides(
        "suppliers",
        suppliers.map((supplier) => supplier.id)
      ),
    ]);

    // For factory companies, the "Factory worker advances" ledger shows its
    // ledger balance; what the factory_worker_advances table holds over it is
    // reported in `notInLedgerTotal` (it used to replace the balance).
    const workerAdvanceTables = new Map<number, Decimal>();

    if (isFactoryCompany) {
      const workerAdvLedger = ledgers.find(
        (a) => (a.name || "").toLowerCase().replace(/\s+/g, " ").trim() === "factory worker advances"
      );
      if (workerAdvLedger) {
        const workerAdvRes = await db.execute(sql`
            SELECT COALESCE(SUM(remaining_balance::numeric), 0) AS total
            FROM factory_worker_advances
            WHERE company_id = ${companyId}
              AND remaining_balance > 0
          `);
        const workerAdvRow = resultRows(workerAdvRes)[0] ?? {};
        const workerAdvancesValue = toMoney(String(workerAdvRow.total ?? "0"));
        workerAdvanceTables.set(workerAdvLedger.id, workerAdvancesValue);
      }
    }

    const asOfDate = getClientDate(req);
    const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
    const balStartDate =
      typeof req.query.startDate === "string" && ISO_DATE.test(req.query.startDate) ? req.query.startDate : undefined;
    const rawEndDate =
      typeof req.query.endDate === "string" && ISO_DATE.test(req.query.endDate) ? req.query.endDate : undefined;
    // One end-date rule with the balance engine (wave 17 A, statementWindow.ts):
    // an explicit endDate cuts the balances; without one they are everything
    // posted, as every other balance card (it used to stop at the client's today).
    const effectiveEndDate = rawEndDate;

    // A ledger account a customer owns shows that customer's balance from the
    // one balance engine (customer-owned opening counted once, its linked
    // ledger and customer-tagged lines, effective-date basis), the same figure
    // as the trial balance. Amounts not yet in the ledger (factory invoices
    // before the perpetual cut-over, factory POS credit sales, cache-only rows)
    // are reported in `notInLedgerTotal`, never added to `balance`; the factory
    // composite that used to add them is retired.
    const customerParties = await getPartyBalances(db, {
      companyId,
      kind: "customer",
      asOf: effectiveEndDate,
      from: balStartDate ?? null,
      memo: true,
    });
    const customerByLedger = new Map(
      customerParties.parties
        .filter((party) => party.linkedLedgerAccountId !== null)
        .map((party) => [party.linkedLedgerAccountId as number, party])
    );

    // Wave 18 C: ledger, bank, fixed-asset and employee balances are the
    // balance engine's rows (one scan of the company's lines): each line
    // counted once by the engine's ownership (a line naming a ledger and a
    // bank is the ledger's, no longer also the bank's), this company's
    // vouchers only, effective-date basis, and openings with the engine's side
    // rule (a sideless ledger opening takes its type's usual side). With a
    // start date the engine carries the earlier lines into the opening.
    const engineRows = await loadBalanceRows(db, {
      companyId,
      asOf: effectiveEndDate ?? null,
      from: balStartDate ?? null,
    });
    const engineByKind = new Map<string, PartyBalance>();
    for (const row of engineRows) {
      if (row.id === null) continue;
      if (row.kind === "ledger" || row.kind === "bank" || row.kind === "fixedAsset" || row.kind === "employee") {
        engineByKind.set(`${row.kind}:${row.id}`, toPartyBalance(row));
      }
    }
    const ZERO = new MoneyDecimal(0);
    /** Dr-positive closing and the opening shown (carried with a start date, else the master's). */
    const engineFigures = (kind: "ledger" | "bank" | "fixedAsset" | "employee", id: number) => {
      const party = engineByKind.get(`${kind}:${id}`);
      return {
        closing: party ? toMoney(party.closing) : ZERO,
        opening: party ? toMoney(balStartDate ? party.opening : party.masterOpening) : ZERO,
      };
    };
    /** Dr-positive figures as the list shows them: an amount and its side. */
    const drPositive = (kind: "ledger" | "bank" | "fixedAsset", id: number) => {
      const { closing, opening } = engineFigures(kind, id);
      return {
        balance: closing.abs(),
        balanceSide: closing.greaterThanOrEqualTo(0) ? "Dr" : "Cr",
        openingBalance: opening.abs().toNumber(),
        openingBalanceSide: opening.greaterThanOrEqualTo(0) ? "Dr" : "Cr",
      };
    };
    /** An opening of zero keeps its master's side (the engine's rule) for display. */
    const masterSide = (kind: "ledger" | "bank", accountType: string | null | undefined, side: string | null) =>
      openingSideOf(kind, accountType, side).side;

    const accounts = [
      ...ledgers.map((account) => {
        const customerParty = customerByLedger.get(account.id);
        if (customerParty) {
          const closing = toMoney(customerParty.closing);
          const opening = toMoney(balStartDate ? customerParty.opening : customerParty.masterOpening);
          return {
            id: `ledger-${account.id}`,
            accountId: account.id,
            type: "ledger",
            code: account.code,
            name: account.name,
            accountType: account.accountType,
            subType: account.subType,
            balance: closing.abs().toFixed(2),
            balanceSide: closing.lessThan(0) ? "Cr" : "Dr",
            openingBalance: opening.abs().toNumber(),
            openingBalanceSide: opening.lessThan(0) ? "Cr" : "Dr",
            active: account.active,
            parentId: account.parentId,
            customerId: customerParty.id,
            balanceBasis: "ledger" as const,
            notInLedgerTotal: customerParty.memoTotal,
          };
        }

        const figures = drPositive("ledger", account.id);
        const workerTable = workerAdvanceTables.get(account.id);
        return {
          id: `ledger-${account.id}`,
          accountId: account.id,
          type: "ledger",
          code: account.code,
          name: account.name,
          accountType: account.accountType,
          subType: account.subType,
          balance: figures.balance.toFixed(2),
          balanceSide: figures.balanceSide,
          openingBalance: figures.openingBalance,
          openingBalanceSide:
            figures.openingBalance === 0
              ? masterSide("ledger", account.accountType, account.openingBalanceSide)
              : figures.openingBalanceSide,
          active: account.active,
          parentId: account.parentId,
          ...(workerTable
            ? {
                notInLedgerTotal: workerTable
                  .minus(figures.balanceSide === "Dr" ? figures.balance : figures.balance.negated())
                  .toFixed(2),
              }
            : {}),
        };
      }),
      ...banks.map((account) => {
        const figures = drPositive("bank", account.id);
        return {
          id: `bank-${account.id}`,
          accountId: account.id,
          type: "bank",
          code: account.code,
          name: `${account.name} (${account.bankName})`,
          balance: figures.balance.toFixed(2),
          balanceSide: figures.balanceSide,
          openingBalance: figures.openingBalance,
          openingBalanceSide:
            figures.openingBalance === 0
              ? masterSide("bank", "Bank", account.openingBalanceSide)
              : figures.openingBalanceSide,
          active: account.active,
          parentId: null,
        };
      }),
      ...assets.map((asset) => {
        const figures = drPositive("fixedAsset", asset.id);
        return {
          id: `asset-${asset.id}`,
          accountId: asset.id,
          type: "fixedAsset",
          code: asset.code,
          name: asset.name,
          balance: figures.balance.toFixed(2),
          balanceSide: figures.balanceSide,
          openingBalance: figures.openingBalance,
          openingBalanceSide: figures.openingBalance === 0 ? "Dr" : figures.openingBalanceSide,
          active: asset.active,
          parentId: null,
        };
      }),
      ...employees.map((employee) => {
        // Employees are credit-normal (Cr positive); the engine's opening side
        // rule applies (a sideless employee opening is Cr).
        const { closing, opening } = engineFigures("employee", employee.id);
        const netBalance = closing.negated();
        const openingCr = opening.negated();
        const storedSide = employeeOpeningSides.get(employee.id) ?? "Cr";
        return {
          id: `employee-${employee.id}`,
          accountId: employee.id,
          type: "employee",
          code: employee.code,
          name: `${employee.firstName} ${employee.lastName}`,
          balance: netBalance.abs().toFixed(2),
          balanceSide: netBalance.greaterThanOrEqualTo(0) ? "Cr" : "Dr",
          openingBalance: openingCr.abs().toNumber(),
          openingBalanceSide: openingCr.isZero() ? storedSide : openingCr.greaterThan(0) ? "Cr" : "Dr",
          active: employee.active,
          parentId: null,
        };
      }),
    ];

    // Factory and Properties companies never expose supplier accounts here.
    // Wave 14: every supplier the company owns is listed, with or without
    // activity; a child company (companies.parent_company_id) used to hide its
    // own suppliers that had no lines and no opening.
    const supplierAccountsList =
      suppliers.length === 0
        ? []
        : await (async () => {
            return (
              await Promise.all(
                suppliers.map(async (supplier) => {
                  // Same period as the other families: lines up to the end
                  // date count, and lines before the start date are carried
                  // into the opening.
                  const {
                    balance: calculatedBalance,
                    openingBalance: storedOpening,
                    openingBalanceSide: storedOpeningSide,
                    periodOpeningBalance,
                  } = await getSupplierBalanceForContext(
                    { ...supplier, openingBalanceSide: supplierOpeningSides.get(supplier.id) ?? "Cr" },
                    companyId,
                    { allowUnconfiguredLegacyScope: true, endDate: effectiveEndDate, startDate: balStartDate }
                  );

                  const balanceSide = calculatedBalance >= 0 ? "Cr" : "Dr";
                  const openingBalance = balStartDate ? Math.abs(periodOpeningBalance) : storedOpening;
                  const openingBalanceSide = balStartDate
                    ? periodOpeningBalance >= 0
                      ? "Cr"
                      : "Dr"
                    : storedOpeningSide;

                  return {
                    id: `supplier-${supplier.id}`,
                    accountId: supplier.id,
                    type: "supplier",
                    code: supplier.code,
                    name: supplier.legalName,
                    balance: calculatedBalance.toFixed(2),
                    balanceSide,
                    openingBalance,
                    openingBalanceSide,
                    active: supplier.active,
                    parentId: null,
                    ...(supplier.companyId !== companyId ? { postedFromOtherCompany: true } : {}),
                  };
                })
              )
            ).filter((s): s is NonNullable<typeof s> => s !== null);
          })();

    if (analyticsProfile) {
      return res.json({
        accounts: accounts
          .filter((account) => account.type === "ledger" || account.type === "bank" || account.type === "fixedAsset")
          .map((account) => ({
            id: account.id,
            accountId: account.accountId,
            type: account.type,
            code: account.code ?? "",
            name: account.name ?? "",
            accountType: "accountType" in account ? (account.accountType ?? null) : null,
            subType: "subType" in account ? (account.subType ?? null) : null,
            balance: account.balance ?? "0",
            balanceSide: account.balanceSide ?? null,
            parentId: account.parentId ?? null,
          })),
        asOfDate: effectiveEndDate ?? asOfDate,
        allPosted: !effectiveEndDate,
      });
    }

    // asOfDate stays a date for display; allPosted marks a balance of everything posted.
    res.json({
      accounts: [...accounts, ...supplierAccountsList],
      asOfDate: effectiveEndDate ?? asOfDate,
      allPosted: !effectiveEndDate,
    });
  } catch (error: unknown) {
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

export function registerAccountListRoutes(app: Express) {
  // Factory Agent Ledger must use the Factory-pinned company, not the ERP
  // company selected by another tab. The existing ERP endpoint is unchanged.
  app.get("/api/factory/agents/accounts", requireAuth, requireFactoryPageAccess("factory/agents"), async (req, res) => {
    const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
    if (!companyId) return res.status(400).json({ message: "No company selected" });
    return serveAccountListForCompany(req, res, companyId);
  });

  app.get("/api/accounts/all", requireAuth, async (req, res) => {
    const companyId = req.session.currentCompanyId;
    if (!companyId) {
      return res.status(400).json({ message: "No company selected" });
    }

    return serveAccountListForCompany(req, res, companyId);
  });
}
