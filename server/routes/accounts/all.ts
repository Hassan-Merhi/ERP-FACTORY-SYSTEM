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
import {
  ParentCompanyNotConfiguredError,
  resolveParentCompanyId,
  getSupplierBalanceForContext,
  isSupplierVisibleToCompany,
} from "../helpers/supplierBalanceHelpers";
import { vouchers, voucherEntries, customerBalances, customerOrders } from "@shared/schema";
import { eq, and, inArray, sql, isNull } from "drizzle-orm";
import { getClientDate } from "../../lib/dateUtils";
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
    const [currentCompany, ledgersAll, banks, assets, employees, allSuppliers, companyCustomers] = await Promise.all([
      storage.getCompanyById(companyId),
      storage.getAllLedgerAccounts(companyId, true),
      storage.getAllBankAccounts(companyId),
      storage.getAllFixedAssets(companyId),
      analyticsProfile ? Promise.resolve([]) : storage.getAllEmployees(companyId),
      analyticsProfile ? Promise.resolve([]) : storage.getAllSuppliers(),
      storage.getAllCustomers(companyId),
    ]);
    const ledgers = ledgersAll.filter(
      (a) => !["sp_stock", "sp_opnbal"].includes(a.subType ?? "") && !isSystemOnlyLedgerAccount(a)
    );
    const isFactoryCompany = currentCompany?.companyType === "factory";
    const isPropertiesCompany = currentCompany?.companyType === "properties";
    // getAllSuppliers() is not company-scoped, so foreign tenants' rows have to
    // be dropped here rather than left to the child-company activity filter
    // below, which a company resolving to itself never applies.
    const suppliers =
      isFactoryCompany || isPropertiesCompany
        ? []
        : allSuppliers.filter((supplier) => isSupplierVisibleToCompany(supplier, companyId));

    const customerObMap = new Map<number, { openingBalance: string; openingBalanceSide: string | null }>();
    for (const cust of companyCustomers) {
      if (cust.ledgerAccountId) {
        customerObMap.set(cust.ledgerAccountId, {
          openingBalance: cust.openingBalance ?? "0",
          openingBalanceSide: cust.openingBalanceSide ?? "Dr",
        });
      }
    }

    // For factory companies, compute the same combined customer balance used
    // by the Factory Customers page.
    const customerLedgerOverrides = new Map<number, { balance: string; balanceSide: string }>();
    if (isFactoryCompany) {
      const linkedCustomers = companyCustomers.filter((c) => c.ledgerAccountId);
      if (linkedCustomers.length > 0) {
        const linkedCustIds = linkedCustomers.map((c) => c.id);
        const linkedLedgerIds = linkedCustomers.map((c) => c.ledgerAccountId!);

        const [salesRows, cbRows, lVoucherRows, cVoucherRows] = await Promise.all([
          db
            .select({
              customerId: customerOrders.customerId,
              total: sql<string>`COALESCE(SUM(CAST(${customerOrders.grandTotal} AS numeric)), 0)`,
            })
            .from(customerOrders)
            .where(
              and(
                inArray(customerOrders.customerId, linkedCustIds),
                eq(customerOrders.companyId, companyId),
                eq(customerOrders.status, "FINALIZED")
              )
            )
            .groupBy(customerOrders.customerId),

          db
            .select({
              customerId: customerBalances.customerId,
              net: sql<string>`COALESCE(SUM(CAST(${customerBalances.debitAmount} AS numeric) - CAST(${customerBalances.creditAmount} AS numeric)), 0)`,
            })
            .from(customerBalances)
            .where(
              and(
                inArray(customerBalances.customerId, linkedCustIds),
                eq(customerBalances.companyId, companyId),
                sql`${customerBalances.referenceType} IS DISTINCT FROM 'INVOICE'`
              )
            )
            .groupBy(customerBalances.customerId),

          db
            .select({
              ledgerAccountId: voucherEntries.ledgerAccountId,
              net: sql<string>`COALESCE(SUM(CAST(${voucherEntries.debitAmount} AS numeric) - CAST(${voucherEntries.creditAmount} AS numeric)), 0)`,
            })
            .from(voucherEntries)
            .innerJoin(
              vouchers,
              and(
                eq(voucherEntries.voucherId, vouchers.id),
                eq(vouchers.companyId, companyId),
                eq(vouchers.optional, false),
                isNull(vouchers.deletedAt),
                sql`${vouchers.voucherNumber} NOT LIKE 'CHARGE-%' AND ${vouchers.voucherNumber} NOT LIKE 'INV-%'`
              )
            )
            .where(inArray(voucherEntries.ledgerAccountId, linkedLedgerIds))
            .groupBy(voucherEntries.ledgerAccountId),

          db
            .select({
              customerId: voucherEntries.customerId,
              net: sql<string>`COALESCE(SUM(CAST(${voucherEntries.debitAmount} AS numeric) - CAST(${voucherEntries.creditAmount} AS numeric)), 0)`,
            })
            .from(voucherEntries)
            .innerJoin(
              vouchers,
              and(
                eq(voucherEntries.voucherId, vouchers.id),
                eq(vouchers.companyId, companyId),
                eq(vouchers.optional, false),
                isNull(vouchers.deletedAt),
                sql`${vouchers.voucherNumber} NOT LIKE 'CHARGE-%' AND ${vouchers.voucherNumber} NOT LIKE 'INV-%'`
              )
            )
            .where(and(inArray(voucherEntries.customerId, linkedCustIds), isNull(voucherEntries.ledgerAccountId)))
            .groupBy(voucherEntries.customerId),
        ]);

        const salesMap = new Map(salesRows.map((r) => [r.customerId!, toMoney(r.total)]));
        const nonInvMap = new Map(cbRows.map((r) => [r.customerId!, toMoney(r.net)]));
        const vNetByLedger = new Map(
          lVoucherRows.filter((r) => r.ledgerAccountId).map((r) => [r.ledgerAccountId!, toMoney(r.net)])
        );
        const vNetByCustomer = new Map(
          cVoucherRows.filter((r) => r.customerId).map((r) => [r.customerId!, toMoney(r.net)])
        );
        const NONE = new MoneyDecimal(0);

        for (const cust of linkedCustomers) {
          const salesTotal = salesMap.get(cust.id) ?? NONE;
          const nonInvNet = nonInvMap.get(cust.id) ?? NONE;
          const voucherNet = (vNetByLedger.get(cust.ledgerAccountId!) ?? NONE).plus(
            vNetByCustomer.get(cust.id) ?? NONE
          );
          const ob = toMoney(cust.openingBalance);
          const obSide = cust.openingBalanceSide || "Dr";
          const total = (obSide === "Dr" ? ob : ob.negated()).plus(salesTotal).plus(nonInvNet).plus(voucherNet);
          customerLedgerOverrides.set(cust.ledgerAccountId!, {
            balance: total.abs().toFixed(2),
            balanceSide: total.greaterThanOrEqualTo(0) ? "Dr" : "Cr",
          });
        }
      }
    }

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
        customerLedgerOverrides.set(workerAdvLedger.id, {
          balance: workerAdvancesValue.toFixed(2),
          balanceSide: "Dr",
        });
      }
    }

    const asOfDate = getClientDate(req);
    const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
    const balStartDate =
      typeof req.query.startDate === "string" && ISO_DATE.test(req.query.startDate) ? req.query.startDate : undefined;
    const rawEndDate =
      typeof req.query.endDate === "string" && ISO_DATE.test(req.query.endDate) ? req.query.endDate : undefined;
    const effectiveEndDate = rawEndDate && rawEndDate < asOfDate ? rawEndDate : asOfDate;

    const voucherDateConditions = [
      eq(vouchers.companyId, companyId),
      eq(vouchers.optional, false),
      isNull(vouchers.deletedAt),
      ...(balStartDate ? [sql`COALESCE(${vouchers.effectiveDate}, ${vouchers.voucherDate}) >= ${balStartDate}`] : []),
      sql`COALESCE(${vouchers.effectiveDate}, ${vouchers.voucherDate}) <= ${effectiveEndDate}`,
    ];

    const ledgerIds = ledgers.map((a) => a.id);
    const ledgerIdSet = new Set(ledgerIds);

    // Phase 4: one aggregate scan replaces the previous three-step
    // voucher-id -> raw-entry -> ledger-entry read path. The old endpoint
    // materialized every matching voucher entry in Node just to sum four
    // account dimensions. PostgreSQL now returns only grouped totals.
    const movementRows = await db
      .select({
        ledgerAccountId: voucherEntries.ledgerAccountId,
        bankAccountId: voucherEntries.bankAccountId,
        fixedAssetId: voucherEntries.fixedAssetId,
        employeeId: voucherEntries.employeeId,
        debits: sql<string>`COALESCE(SUM(CAST(${voucherEntries.debitAmount} AS numeric)), 0)`,
        credits: sql<string>`COALESCE(SUM(CAST(${voucherEntries.creditAmount} AS numeric)), 0)`,
      })
      .from(voucherEntries)
      .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
      .where(and(...voucherDateConditions))
      .groupBy(
        voucherEntries.ledgerAccountId,
        voucherEntries.bankAccountId,
        voucherEntries.fixedAssetId,
        voucherEntries.employeeId
      );

    type Movement = { debits: Decimal; credits: Decimal };
    const NO_MOVEMENT: Movement = { debits: new MoneyDecimal(0), credits: new MoneyDecimal(0) };
    const ledgerBalances = new Map<number, Movement>();
    const bankBalances = new Map<number, Movement>();
    const assetBalances = new Map<number, Movement>();
    const employeeBalances = new Map<number, Movement>();

    const addMovement = (
      target: Map<number, Movement>,
      id: number | null | undefined,
      debits: Decimal,
      credits: Decimal
    ) => {
      if (!id) return;
      const existing = target.get(id) || NO_MOVEMENT;
      target.set(id, {
        debits: existing.debits.plus(debits),
        credits: existing.credits.plus(credits),
      });
    };

    for (const row of movementRows) {
      const debits = toMoney(row.debits);
      const credits = toMoney(row.credits);
      if (row.ledgerAccountId && ledgerIdSet.has(row.ledgerAccountId)) {
        addMovement(ledgerBalances, row.ledgerAccountId, debits, credits);
      }
      addMovement(bankBalances, row.bankAccountId, debits, credits);
      addMovement(assetBalances, row.fixedAssetId, debits, credits);
      addMovement(employeeBalances, row.employeeId, debits, credits);
    }

    const calculateBalance = (
      openingBalance: string,
      openingBalanceSide: string | null,
      debits: Decimal,
      credits: Decimal
    ) => {
      let balance = toMoney(openingBalance);
      if (openingBalanceSide === "Cr") balance = balance.negated();
      balance = balance.plus(debits).minus(credits);
      const balanceSide = balance.greaterThanOrEqualTo(0) ? "Dr" : "Cr";
      return { balance: balance.abs(), balanceSide };
    };

    const accounts = [
      ...ledgers.map((account) => {
        const movements = ledgerBalances.get(account.id) || NO_MOVEMENT;
        const custOb = customerObMap.get(account.id);
        const effectiveOB = custOb?.openingBalance ?? account.openingBalance ?? "0";
        const effectiveOBSide = custOb?.openingBalanceSide ?? account.openingBalanceSide;

        const override = customerLedgerOverrides.get(account.id);
        if (override) {
          return {
            id: `ledger-${account.id}`,
            accountId: account.id,
            type: "ledger",
            code: account.code,
            name: account.name,
            accountType: account.accountType,
            subType: account.subType,
            balance: override.balance,
            balanceSide: override.balanceSide,
            openingBalance: toMoney(effectiveOB).toNumber(),
            openingBalanceSide: effectiveOBSide || "Dr",
            active: account.active,
            parentId: account.parentId,
          };
        }

        const { balance, balanceSide } = calculateBalance(
          effectiveOB,
          effectiveOBSide,
          movements.debits,
          movements.credits
        );
        return {
          id: `ledger-${account.id}`,
          accountId: account.id,
          type: "ledger",
          code: account.code,
          name: account.name,
          accountType: account.accountType,
          subType: account.subType,
          balance: balance.toFixed(2),
          balanceSide,
          openingBalance: toMoney(effectiveOB).toNumber(),
          openingBalanceSide: effectiveOBSide || "Dr",
          active: account.active,
          parentId: account.parentId,
        };
      }),
      ...banks.map((account) => {
        const movements = bankBalances.get(account.id) || NO_MOVEMENT;
        const { balance, balanceSide } = calculateBalance(
          account.openingBalance || "0",
          account.openingBalanceSide,
          movements.debits,
          movements.credits
        );
        return {
          id: `bank-${account.id}`,
          accountId: account.id,
          type: "bank",
          code: account.code,
          name: `${account.name} (${account.bankName})`,
          balance: balance.toFixed(2),
          balanceSide,
          openingBalance: toMoney(account.openingBalance).toNumber(),
          openingBalanceSide: account.openingBalanceSide || "Dr",
          active: account.active,
          parentId: null,
        };
      }),
      ...assets.map((asset) => {
        const movements = assetBalances.get(asset.id) || NO_MOVEMENT;
        const { balance, balanceSide } = calculateBalance(
          asset.openingBalance || "0",
          "Dr",
          movements.debits,
          movements.credits
        );
        return {
          id: `asset-${asset.id}`,
          accountId: asset.id,
          type: "fixedAsset",
          code: asset.code,
          name: asset.name,
          balance: balance.toFixed(2),
          balanceSide,
          openingBalance: toMoney(asset.openingBalance).toNumber(),
          openingBalanceSide: "Dr",
          active: asset.active,
          parentId: null,
        };
      }),
      ...employees.map((employee) => {
        const movements = employeeBalances.get(employee.id) || NO_MOVEMENT;
        const openingBalanceExact = toMoney(employee.openingBalance);
        const openingBalance = openingBalanceExact.toNumber();
        const netBalance = openingBalanceExact.plus(movements.credits).minus(movements.debits);
        const balanceSide = netBalance.greaterThanOrEqualTo(0) ? "Cr" : "Dr";
        return {
          id: `employee-${employee.id}`,
          accountId: employee.id,
          type: "employee",
          code: employee.code,
          name: `${employee.firstName} ${employee.lastName}`,
          balance: netBalance.abs().toFixed(2),
          balanceSide,
          openingBalance,
          openingBalanceSide: "Cr",
          active: employee.active,
          parentId: null,
        };
      }),
    ];

    // Factory and Properties companies never expose supplier accounts here, so
    // do not perform legacy parent-company resolution for an empty supplier set.
    const supplierAccountsList =
      suppliers.length === 0
        ? []
        : await (async () => {
            let isChildCompany = false;
            try {
              const parentCompanyId = await resolveParentCompanyId(companyId);
              isChildCompany = companyId !== parentCompanyId;
            } catch (error) {
              if (!(error instanceof ParentCompanyNotConfiguredError)) throw error;
              isChildCompany = true;
            }

            return (
              await Promise.all(
                suppliers.map(async (supplier) => {
                  const {
                    balance: calculatedBalance,
                    openingBalance,
                    hasActivity,
                  } = await getSupplierBalanceForContext(supplier, companyId, {
                    allowUnconfiguredLegacyScope: true,
                  });

                  if (isChildCompany && !hasActivity) return null;
                  const balanceSide = calculatedBalance >= 0 ? "Cr" : "Dr";

                  return {
                    id: `supplier-${supplier.id}`,
                    accountId: supplier.id,
                    type: "supplier",
                    code: supplier.code,
                    name: supplier.legalName,
                    balance: calculatedBalance.toFixed(2),
                    balanceSide,
                    openingBalance,
                    openingBalanceSide: "Cr",
                    active: supplier.active,
                    parentId: null,
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
        asOfDate: effectiveEndDate,
      });
    }

    res.json({ accounts: [...accounts, ...supplierAccountsList], asOfDate: effectiveEndDate });
  } catch (error: unknown) {
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

export function registerAccountListRoutes(app: Express) {
  app.get("/api/accounts/all", requireAuth, async (req, res) => {
    const companyId = req.session.currentCompanyId;
    if (!companyId) {
      return res.status(400).json({ message: "No company selected" });
    }

    return serveAccountListForCompany(req, res, companyId);
  });
}
