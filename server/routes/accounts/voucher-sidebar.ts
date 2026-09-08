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
import { resolveParentCompanyId, isSupplierVisibleToCompany } from "../helpers/supplierBalanceHelpers";
import {
  vouchers,
  voucherEntries,
  ledgerAccounts,
  factorySuppliers,
  factoryContainers,
  factorySupplierPayments,
} from "@shared/schema";
import { eq, and, sql, isNull } from "drizzle-orm";

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

      // Parent is resolved from the active company's explicit relationship,
      // with the legacy global setting retained only as a compatibility
      // fallback for unlinked historical data.
      const parentCompanyId = await resolveParentCompanyId(companyId);
      const isChildCompany = companyId !== parentCompanyId;

      // Phase 1: determine company type (other fetches are conditional on this)
      const currentCompany = await storage.getCompanyById(companyId);
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
        allSuppliers,
        fSuppliers,
        fContainers,
        fPayments,
        companyVouchers,
        allEntries,
        ledgerAccountEntries,
      ] = await Promise.all([
        storage.getAllLedgerAccounts(companyId, true), // include hidden so cash/loan/bank accounts appear in pickers
        storage.getAllBankAccounts(companyId),
        storage.getAllFixedAssets(companyId),
        storage.getAllEmployees(companyId),
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
        db
          .select({
            id: vouchers.id,
            voucherNumber: vouchers.voucherNumber,
            currency: vouchers.currency,
            exchangeRate: vouchers.exchangeRate,
          })
          .from(vouchers)
          .where(and(eq(vouchers.companyId, companyId), eq(vouchers.optional, false), isNull(vouchers.deletedAt)))
          .execute(),
        // Company-scoped entries remain authoritative for supplier, bank,
        // employee, fixed-asset and factory-supplier balances.
        db
          .select()
          .from(voucherEntries)
          .where(
            sql`${voucherEntries.voucherId} IN (SELECT id FROM vouchers WHERE company_id = ${companyId} AND optional = false AND deleted_at IS NULL)`
          )
          .execute(),
        // Ledger balances intentionally follow the ledger account's company.
        // This mirrors statsNetPositionRoutes and keeps journal "New Bal" in
        // sync with the balance sheet after account/voucher migrations.
        db
          .select({
            ledgerAccountId: voucherEntries.ledgerAccountId,
            debitAmount: voucherEntries.debitAmount,
            creditAmount: voucherEntries.creditAmount,
          })
          .from(voucherEntries)
          .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
          .innerJoin(ledgerAccounts, eq(voucherEntries.ledgerAccountId, ledgerAccounts.id))
          .where(
            and(
              eq(ledgerAccounts.companyId, companyId),
              eq(vouchers.optional, false),
              isNull(vouchers.deletedAt)
            )
          )
          .execute(),
      ]);
      // Strip internal system-only accounts (sp_stock, sp_opnbal are isHidden=true for a reason)
      const ledgers = ledgersRaw.filter((a) => !["sp_stock", "sp_opnbal"].includes(a.subType ?? ""));

      // getAllSuppliers() is not company-scoped, so foreign tenants' rows have to
      // be dropped here rather than left to the isChildCompany filter below, which
      // a company resolving to itself never applies — and which would otherwise
      // also apply those suppliers' opening balances.
      const suppliers = allSuppliers.filter((supplier) => isSupplierVisibleToCompany(supplier, companyId));

      const _companyVoucherIds = companyVouchers.map((v) => v.id);
      // FACTORY-PAY-* voucher IDs — excluded when computing factory supplier voucher-paid amounts
      // to prevent double-counting with fPayments (factorySupplierPayments).
      const factoryPayVoucherIds = new Set(
        companyVouchers.filter((v) => (v.voucherNumber || "").startsWith("FACTORY-PAY-")).map((v) => v.id)
      );
      // Map from voucherId -> {currency, exchangeRate} for USD conversion of factory supplier entries
      const voucherCurrencyMap = new Map<number, { currency: string; exchangeRate: string }>(
        companyVouchers.map((v) => [v.id, { currency: v.currency || "USD", exchangeRate: v.exchangeRate || "1" }])
      );

      // Group entries by account type and calculate balances
      const ledgerBalances = new Map<number, { debits: number; credits: number }>();
      const bankBalances = new Map<number, { debits: number; credits: number }>();
      const assetBalances = new Map<number, { debits: number; credits: number }>();
      const supplierBalances = new Map<number, number>();
      const employeeBalances = new Map<number, { debits: number; credits: number }>();
      const factorySupplierBalances = new Map<number, number>();
      const customerBalances = new Map<number, { debits: number; credits: number }>();

      for (const entry of ledgerAccountEntries) {
        if (!entry.ledgerAccountId) continue;
        const debit = parseFloat(entry.debitAmount || "0");
        const credit = parseFloat(entry.creditAmount || "0");
        const existing = ledgerBalances.get(entry.ledgerAccountId) || { debits: 0, credits: 0 };
        ledgerBalances.set(entry.ledgerAccountId, {
          debits: existing.debits + debit,
          credits: existing.credits + credit,
        });
      }

      for (const entry of allEntries) {
        const debit = parseFloat(entry.debitAmount || "0");
        const credit = parseFloat(entry.creditAmount || "0");

        if (entry.bankAccountId) {
          const existing = bankBalances.get(entry.bankAccountId) || { debits: 0, credits: 0 };
          bankBalances.set(entry.bankAccountId, {
            debits: existing.debits + debit,
            credits: existing.credits + credit,
          });
        }

        if (entry.fixedAssetId) {
          const existing = assetBalances.get(entry.fixedAssetId) || { debits: 0, credits: 0 };
          assetBalances.set(entry.fixedAssetId, {
            debits: existing.debits + debit,
            credits: existing.credits + credit,
          });
        }

        if (entry.supplierId) {
          const existing = supplierBalances.get(entry.supplierId) || 0;
          // Only count pure credit or pure debit entries to prevent double-counting
          if (credit > 0 && debit === 0) {
            supplierBalances.set(entry.supplierId, existing + credit); // Increase payable
          } else if (debit > 0 && credit === 0) {
            supplierBalances.set(entry.supplierId, existing - debit); // Decrease payable
          }
        }

        if (entry.factorySupplierId) {
          const fsId = entry.factorySupplierId as number;
          // Only track non-FACTORY-PAY-* debits as ERP voucher payments.
          // FACTORY-PAY-* vouchers are already counted via fPayments.
          if (!factoryPayVoucherIds.has(entry.voucherId) && debit > 0 && credit === 0) {
            // Convert to USD using the voucher's exchange rate
            const vInfo = voucherCurrencyMap.get(entry.voucherId) || { currency: "USD", exchangeRate: "1" };
            const fx = parseFloat(vInfo.exchangeRate) || 1;
            const debitUsd = vInfo.currency === "USD" ? debit : debit / fx;
            const existing = factorySupplierBalances.get(fsId) || 0;
            factorySupplierBalances.set(fsId, existing + debitUsd);
          }
        }

        if (entry.employeeId) {
          const existing = employeeBalances.get(entry.employeeId) || { debits: 0, credits: 0 };
          employeeBalances.set(entry.employeeId, {
            debits: existing.debits + debit,
            credits: existing.credits + credit,
          });
        }

        if (entry.customerId) {
          const cId = entry.customerId as number;
          const existing = customerBalances.get(cId) || { debits: 0, credits: 0 };
          customerBalances.set(cId, {
            debits: existing.debits + debit,
            credits: existing.credits + credit,
          });
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
          const balance = calculateSignedBalance(
            account.openingBalance || "0",
            account.openingBalanceSide,
            movements.debits,
            movements.credits
          );

          return {
            id: account.id,
            type: "ledger",
            name: account.name,
            code: account.code,
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
          const linkedChildIds = (fSuppliers as any[]).filter((s) => s.parentId === supplier.id).map((s) => s.id);
          const aggregateIds = [supplier.id, ...linkedChildIds];

          // Container value: sum((actualReceivedKg || totalKg) * ratePerKg + freight) * fxRateToUsd
          const supplierContainers = fContainers.filter((c) => aggregateIds.includes(c.supplierId));
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
              !aggregateIds.includes(c.supplierId) &&
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
        // Customers appended below after async balance computation
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

      // Customers are excluded from the voucher account selector — only ledger/bank/supplier accounts appear
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
