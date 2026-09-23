/**
 * accountRoutes: AccountVoucherSidebar endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth } from "../../auth";
import { isSupplierVisibleToCompany } from "../helpers/supplierBalanceHelpers";
import { getCustomersWithBalances } from "../customers/customerBalanceQuery";
import {
  vouchers,
  voucherEntries,
  ledgerAccounts,
  factorySuppliers,
  factoryContainers,
  factorySupplierPayments,
} from "@shared/schema";
import { eq, and, sql, isNull, isNotNull, notInArray, or } from "drizzle-orm";

export function registerAccountVoucherSidebarRoutes(app: Express) {
  const _vsBCache = new Map();

  app.get("/api/accounts/voucher-sidebar", requireAuth, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const companyId = req.session.currentCompanyId;

      // Check TTL cache
      const _vsCached = _vsBCache.get(companyId);
      if (_vsCached && Date.now() < _vsCached.expiresAt) {
        return res.json(_vsCached.data);
      }

      // Resolve the selected company and the small set of vouchers that must
      // never affect balances in parallel. The voucher-entry RLS policy already
      // enforces tenant/authorized-company visibility, so the ledger aggregate
      // can avoid rejoining vouchers for every entry below.
      const [currentCompany, excludedLedgerVouchers] = await Promise.all([
        storage.getCompanyById(companyId),
        db
          .select({ id: vouchers.id })
          .from(vouchers)
          .where(or(eq(vouchers.optional, true), isNotNull(vouchers.deletedAt))),
      ]);
      const parentCompanyId = currentCompany?.parentCompanyId || companyId;
      const isChildCompany = companyId !== parentCompanyId;
      const excludedLedgerVoucherIds = excludedLedgerVouchers.map((voucher) => voucher.id);

      const isFactoryCompany = currentCompany?.companyType === "factory";
      const isPropertiesCompany = currentCompany?.companyType === "properties";

      // Phase 2: all independent fetches in parallel.
      //
      // IMPORTANT: ledger balances are scoped by ledger-account ownership, not
      // voucher ownership. Migrated/intercompany vouchers may legitimately keep
      // their original voucher.company_id while their ledger entry points at an
      // account now owned by the selected company. Net Position already uses this
      // rule; the voucher sidebar must use the same source or journal previews can
      // show the exact opposite running balance from the balance sheet.
      const [
        ledgersRaw,
        banks,
        assets,
        employees,
        customersWithBalances,
        allSuppliers,
        fSuppliers,
        fContainers,
        fPayments,
        movementRows,
        ledgerMovementRows,
      ] = await Promise.all([
        storage.getAllLedgerAccounts(companyId, true), // include hidden so cash/loan/bank accounts appear in pickers
        storage.getAllBankAccounts(companyId),
        storage.getAllFixedAssets(companyId),
        storage.getAllEmployees(companyId),
        getCustomersWithBalances(companyId),
        isFactoryCompany || isPropertiesCompany ? Promise.resolve([]) : storage.getAllSuppliers(),
        isFactoryCompany
          ? db
              .select()
              .from(factorySuppliers)
              .where(eq(factorySuppliers.companyId, companyId))
              .orderBy(factorySuppliers.name)
          : Promise.resolve([]),
        isFactoryCompany
          ? db.select().from(factoryContainers).where(eq(factoryContainers.companyId, companyId))
          : Promise.resolve([]),
        isFactoryCompany
          ? db.select().from(factorySupplierPayments).where(eq(factorySupplierPayments.companyId, companyId))
          : Promise.resolve([]),
        // The sidebar only needs account totals. Aggregate company-scoped
        // non-ledger movements in PostgreSQL instead of materializing the full
        // voucher-entry history in Node on every cold-cache read.
        db
          .select({
            bankAccountId: voucherEntries.bankAccountId,
            fixedAssetId: voucherEntries.fixedAssetId,
            supplierId: voucherEntries.supplierId,
            employeeId: voucherEntries.employeeId,
            factorySupplierId: voucherEntries.factorySupplierId,
            debits: sql<string>`COALESCE(SUM(CAST(${voucherEntries.debitAmount} AS numeric)), 0)`,
            credits: sql<string>`COALESCE(SUM(CAST(${voucherEntries.creditAmount} AS numeric)), 0)`,
            supplierPureCredits: sql<string>`COALESCE(SUM(
              CASE
                WHEN ${voucherEntries.supplierId} IS NOT NULL
                  AND CAST(${voucherEntries.creditAmount} AS numeric) > 0
                  AND CAST(${voucherEntries.debitAmount} AS numeric) = 0
                THEN CAST(${voucherEntries.creditAmount} AS numeric)
                ELSE 0
              END
            ), 0)`,
            supplierPureDebits: sql<string>`COALESCE(SUM(
              CASE
                WHEN ${voucherEntries.supplierId} IS NOT NULL
                  AND CAST(${voucherEntries.debitAmount} AS numeric) > 0
                  AND CAST(${voucherEntries.creditAmount} AS numeric) = 0
                THEN CAST(${voucherEntries.debitAmount} AS numeric)
                ELSE 0
              END
            ), 0)`,
            factorySupplierVoucherPaidUsd: sql<string>`COALESCE(SUM(
              CASE
                WHEN ${voucherEntries.factorySupplierId} IS NOT NULL
                  AND COALESCE(${vouchers.voucherNumber}, '') NOT LIKE 'FACTORY-PAY-%'
                  AND CAST(${voucherEntries.debitAmount} AS numeric) > 0
                  AND CAST(${voucherEntries.creditAmount} AS numeric) = 0
                THEN CASE
                  WHEN COALESCE(${vouchers.currency}, 'USD') = 'USD'
                    THEN CAST(${voucherEntries.debitAmount} AS numeric)
                  ELSE CAST(${voucherEntries.debitAmount} AS numeric) /
                    CASE
                      WHEN COALESCE(CAST(${vouchers.exchangeRate} AS numeric), 0) = 0 THEN 1
                      ELSE CAST(${vouchers.exchangeRate} AS numeric)
                    END
                END
                ELSE 0
              END
            ), 0)`,
          })
          .from(voucherEntries)
          .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
          .where(and(eq(vouchers.companyId, companyId), eq(vouchers.optional, false), isNull(vouchers.deletedAt)))
          .groupBy(
            voucherEntries.bankAccountId,
            voucherEntries.fixedAssetId,
            voucherEntries.supplierId,
            voucherEntries.employeeId,
            voucherEntries.factorySupplierId
          ),
        // Ledger balances intentionally follow ledger-account ownership rather
        // than voucher ownership. voucher_entries RLS already validates the
        // parent voucher's tenant scope; joining vouchers again made PostgreSQL
        // repeat that lookup for every ledger row. Exclude the small optional /
        // deleted set by id instead, preserving balance semantics without the
        // duplicate RLS-backed voucher join.
        db
          .select({
            ledgerAccountId: voucherEntries.ledgerAccountId,
            debits: sql<string>`COALESCE(SUM(CAST(${voucherEntries.debitAmount} AS numeric)), 0)`,
            credits: sql<string>`COALESCE(SUM(CAST(${voucherEntries.creditAmount} AS numeric)), 0)`,
          })
          .from(voucherEntries)
          .innerJoin(ledgerAccounts, eq(voucherEntries.ledgerAccountId, ledgerAccounts.id))
          .where(
            excludedLedgerVoucherIds.length > 0
              ? and(
                  eq(ledgerAccounts.companyId, companyId),
                  notInArray(voucherEntries.voucherId, excludedLedgerVoucherIds)
                )
              : eq(ledgerAccounts.companyId, companyId)
          )
          .groupBy(voucherEntries.ledgerAccountId),
      ]);
      // Strip internal system-only accounts (sp_stock, sp_opnbal are isHidden=true for a reason)
      const ledgers = ledgersRaw.filter((a) => !["sp_stock", "sp_opnbal"].includes(a.subType ?? ""));

      // getAllSuppliers() is not company-scoped, so foreign tenants' rows have to
      // be dropped here rather than left to the isChildCompany filter below, which
      // a company resolving to itself never applies — and which would otherwise
      // also apply those suppliers' opening balances.
      const suppliers = allSuppliers.filter((supplier) => isSupplierVisibleToCompany(supplier, companyId));

      // Fold the compact aggregate rows into the same balance maps used by
      // the response-building code below.
      const ledgerBalances = new Map<number, { debits: number; credits: number }>();
      const bankBalances = new Map<number, { debits: number; credits: number }>();
      const assetBalances = new Map<number, { debits: number; credits: number }>();
      const supplierBalances = new Map<number, number>();
      const employeeBalances = new Map<number, { debits: number; credits: number }>();
      const factorySupplierBalances = new Map<number, number>();

      const addMovement = (
        target: Map<number, { debits: number; credits: number }>,
        id: number | null | undefined,
        debits: number,
        credits: number
      ) => {
        if (!id) return;
        const existing = target.get(id) || { debits: 0, credits: 0 };
        target.set(id, {
          debits: existing.debits + debits,
          credits: existing.credits + credits,
        });
      };

      for (const row of ledgerMovementRows) {
        if (!row.ledgerAccountId) continue;
        addMovement(ledgerBalances, row.ledgerAccountId, parseFloat(row.debits || "0"), parseFloat(row.credits || "0"));
      }

      for (const row of movementRows) {
        const debits = parseFloat(row.debits || "0");
        const credits = parseFloat(row.credits || "0");

        addMovement(bankBalances, row.bankAccountId, debits, credits);
        addMovement(assetBalances, row.fixedAssetId, debits, credits);
        addMovement(employeeBalances, row.employeeId, debits, credits);

        if (row.supplierId) {
          const existing = supplierBalances.get(row.supplierId) || 0;
          supplierBalances.set(
            row.supplierId,
            existing + parseFloat(row.supplierPureCredits || "0") - parseFloat(row.supplierPureDebits || "0")
          );
        }

        if (row.factorySupplierId) {
          const existing = factorySupplierBalances.get(row.factorySupplierId) || 0;
          factorySupplierBalances.set(
            row.factorySupplierId,
            existing + parseFloat(row.factorySupplierVoucherPaidUsd || "0")
          );
        }
      }

      // Opening balance only applies in the parent company's context (see
      // isChildCompany above) — child companies start every supplier at $0 and
      // only reflect movements from this company's own vouchers.

      // Helper function to calculate signed balance (positive = Dr, negative = Cr)
      const calculateSignedBalance = (
        openingBalance: string,
        openingBalanceSide: string | null,
        debits: number,
        credits: number
      ) => {
        let balance = parseFloat(openingBalance || "0");

        // If opening balance has a side, convert to signed number
        if (openingBalanceSide === "Cr") {
          balance = -balance;
        }

        // Add net change (debits increase, credits decrease)
        return balance + debits - credits;
      };

      // Build simplified account array for sidebar
      const accounts = [
        // Bank accounts
        ...banks.map((account) => {
          const movements = bankBalances.get(account.id) || { debits: 0, credits: 0 };
          const balance = calculateSignedBalance(
            account.openingBalance || "0",
            account.openingBalanceSide,
            movements.debits,
            movements.credits
          );

          return {
            id: account.id,
            type: "bank",
            name: account.name,
            code: account.code,
            balance,
          };
        }),
        ...employees.map((employee) => {
          const movements = employeeBalances.get(employee.id) || {
            debits: 0,
            credits: 0,
          };
          const openingBalance = parseFloat(employee.openingBalance || "0");
          // Employee accounts are liability (Cr-normal): credits increase balance, debits decrease it.
          // Positive netBalance = Cr (we owe them, the normal state).
          // This matches the payroll page's currentBalance convention.
          const netBalance = openingBalance + movements.credits - movements.debits;
          const balanceSide = netBalance >= 0 ? "Cr" : "Dr";

          return {
            id: `employee-${employee.id}`,
            accountId: employee.id,
            type: "employee",
            code: employee.code,
            name: `${employee.firstName} ${employee.lastName}`,
            balance: Math.abs(netBalance).toFixed(2),
            balanceSide,
            openingBalance: openingBalance,
            openingBalanceSide: "Cr",
            active: employee.active,
            parentId: null,
          };
        }),
        // Ledger accounts — all included (customer mirror ledgers appear alongside the customer entry)
        ...ledgers.map((account) => {
          const movements = ledgerBalances.get(account.id) || { debits: 0, credits: 0 };
          const signedLedgerBalance = calculateSignedBalance(
            account.openingBalance || "0",
            account.openingBalanceSide,
            movements.debits,
            movements.credits
          );
          const isGoldenCoastSalesCash =
            currentCompany?.companyType === "supplier_partner" &&
            account.subType === "sp_payable" &&
            (account.name || "").trim().toLowerCase() === "gc sales cash";
          // Golden Coast Net Position deliberately shows its credit-normal sales
          // settlement ledger as cash under What We Have. Keep the journal picker
          // on that same presentation sign: positive means the displayed GC cash
          // available, so CR lowers it and DR raises it in the user's journal UI.
          const balance = isGoldenCoastSalesCash ? -signedLedgerBalance : signedLedgerBalance;

          return {
            id: account.id,
            type: "ledger",
            name: account.name,
            code: account.code,
            balance,
          };
        }),
        // Customers are selectable in the journal form, so they must also be
        // present in the balance source used by "New Bal". Previously the client
        // could select a customer while this endpoint omitted customers entirely,
        // causing getAccountBalance() to fall back to 0 and making "New Bal" show
        // only the voucher amount. Use the same canonical customer-balance query as
        // /api/customers/stats and preserve its Dr-positive / Cr-negative sign.
        ...customersWithBalances.map((customer) => {
          const amount = Number(customer.balance || 0);
          const balance = customer.balanceSide === "Cr" ? -amount : amount;

          return {
            id: customer.id,
            type: "customer",
            name: customer.legalName,
            code: customer.code,
            balance,
          };
        }),
        // ERP Suppliers — only included for ERP companies (factory and properties use different account structures).
        // Child companies additionally omit suppliers with no activity in this company.
        ...suppliers
          .filter((supplier) => !isChildCompany || supplierBalances.has(supplier.id))
          .map((supplier) => {
            const transactionBalance = supplierBalances.get(supplier.id) || 0;
            const openingBalance = isChildCompany ? 0 : parseFloat(supplier.openingBalance || "0");
            // Suppliers are always Cr (we owe them). Negate so credit balance is negative in the signed system.
            const balance = -(openingBalance + transactionBalance);

            return {
              id: supplier.id,
              type: "supplier",
              name: supplier.legalName,
              code: supplier.code,
              balance,
            };
          }),
        // Factory Suppliers — only included for factory companies
        // Balance computed from factory tables (containers + payments) for accuracy,
        // matching the computeStats formula: includes freight, voucher payments, broker aggregation.
        ...fSuppliers.map((supplier) => {
          const openingBalance = parseFloat(supplier.openingBalance || "0");

          // Collect all supplier IDs to aggregate (the supplier itself + any children brokered through it)
          const linkedChildIds = fSuppliers.filter((s) => s.parentId === supplier.id).map((s) => s.id);
          const aggregateIds = [supplier.id, ...linkedChildIds];

          // Container value: sum((actualReceivedKg || totalKg) * ratePerKg + freight) * fxRateToUsd
          const supplierContainers = fContainers.filter(
            (c) => c.supplierId != null && aggregateIds.includes(c.supplierId)
          );
          const containerValueUsd = supplierContainers.reduce((sum: number, c) => {
            const kg = parseFloat(c.actualReceivedKg || c.totalKg || "0");
            const rate = parseFloat(c.ratePerKg || "0");
            const freight = parseFloat(c.freight || "0");
            const fx = parseFloat(c.fxRateToUsd || "1");
            return sum + (kg * rate + freight) * fx;
          }, 0);

          // Commission owed to this supplier as broker (exclude containers where they're also the main supplier)
          const brokerContainers = fContainers.filter(
            (c) =>
              c.commissionSupplierId === supplier.id &&
              (c.supplierId == null || !aggregateIds.includes(c.supplierId)) &&
              parseFloat(c.commissionAmount || "0") > 0
          );
          const commissionValueUsd = brokerContainers.reduce((sum: number, c) => {
            const commAmt = parseFloat(c.commissionAmount || "0");
            const fx = parseFloat(c.fxRateToUsd || "1");
            const commCurr = c.commissionCurrencyCode || c.currencyCode || "USD";
            return sum + (commCurr === "USD" ? commAmt : commAmt * fx);
          }, 0);

          // Total paid via factorySupplierPayments (in USD) — aggregated across all linked IDs
          const supplierPayments = fPayments.filter((p) => aggregateIds.includes(p.supplierId));
          const totalPaidUsd = supplierPayments.reduce((sum: number, p) => sum + parseFloat(p.amountUsd || "0"), 0);

          // Total paid via non-FACTORY-PAY-* ERP voucher entries (aggregated across linked IDs)
          const voucherPaidUsd = aggregateIds.reduce((sum, sid) => sum + (factorySupplierBalances.get(sid) || 0), 0);

          // Outstanding balance (positive = we owe them). Negate for sidebar convention (negative = payable/red)
          const outstandingUsd =
            openingBalance + containerValueUsd + commissionValueUsd - totalPaidUsd - voucherPaidUsd;
          const balance = -outstandingUsd;

          return {
            id: supplier.id,
            type: "factorySupplier",
            name: supplier.name,
            code: String(supplier.id),
            balance,
          };
        }),
        // Fixed Assets
        ...assets.map((asset) => {
          const movements = assetBalances.get(asset.id) || { debits: 0, credits: 0 };
          const balance = calculateSignedBalance(
            asset.openingBalance || "0",
            "Dr", // Fixed assets are always debit balance
            movements.debits,
            movements.credits
          );

          return {
            id: asset.id,
            type: "fixedAsset",
            name: asset.name,
            code: asset.code,
            balance,
          };
        }),
      ];

      _vsBCache.set(companyId, { data: accounts, expiresAt: Date.now() + 30_000 });
      if (_vsBCache.size > 100) {
        const now = Date.now();
        for (const [k, v] of _vsBCache) {
          if (now >= v.expiresAt) _vsBCache.delete(k);
        }
      }
      res.json(accounts);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
