/**
 * importCycleRoutes: ImportCycleDiagnostic endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { inventory, containers, ledgerAccounts, vouchers, voucherEntries, employees, locations } from "@shared/schema";
import { eq, and, or, sql, isNull, isNotNull } from "drizzle-orm";
import { sumMoney, toMoney } from "../../lib/money";

export function registerImportCycleDiagnosticRoutes(app: Express) {
  // Import Cycle Diagnostics - analyze and explain what's causing imbalance
  app.get("/api/stats/import-cycle-diagnostics", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      interface DiagnosticIssue {
        id: string;
        severity: "critical" | "warning" | "info";
        title: string;
        description: string;
        impact: number;
        howToFix: string;
        category: string;
      }

      const issues: DiagnosticIssue[] = [];

      // 1. Check for orphaned inventory at deleted locations
      const orphanedInventory = await db
        .select({
          id: inventory.id,
          stockItemId: inventory.stockItemId,
          locationId: inventory.locationId,
          quantity: inventory.quantity,
          totalValue: inventory.totalValue,
        })
        .from(inventory)
        .leftJoin(locations, eq(inventory.locationId, locations.id))
        .where(and(eq(inventory.companyId, companyId), or(isNotNull(locations.deletedAt), isNull(locations.id))));

      if (orphanedInventory.length > 0) {
        const totalOrphanedValue = sumMoney(orphanedInventory.map((inv) => inv.totalValue));

        if (totalOrphanedValue.gt(0)) {
          issues.push({
            id: "orphaned-inventory",
            severity: "critical",
            title: "Orphaned Inventory at Deleted Locations",
            description: `You have ${orphanedInventory.length} inventory records worth $${totalOrphanedValue.toFixed(2)} at locations that have been deleted. This inventory is counted as an asset but doesn't exist in any active location.`,
            impact: totalOrphanedValue.toNumber(),
            howToFix:
              "Go to Settings > System Tools > View Deleted Items > Locations. Either restore the deleted location(s) and transfer the inventory elsewhere, or permanently delete the location which will also remove the orphaned inventory.",
            category: "Orphaned Data",
          });
        }
      }

      // 2. Check for negative inventory (should never happen)
      const negativeInventory = await db
        .select({
          id: inventory.id,
          stockItemId: inventory.stockItemId,
          locationId: inventory.locationId,
          quantity: inventory.quantity,
          totalValue: inventory.totalValue,
        })
        .from(inventory)
        .innerJoin(locations, eq(inventory.locationId, locations.id))
        .where(
          and(
            eq(inventory.companyId, companyId),
            isNull(locations.deletedAt),
            sql`CAST(${inventory.quantity} AS DECIMAL) < 0`
          )
        );

      if (negativeInventory.length > 0) {
        const totalNegativeValue = sumMoney(negativeInventory.map((inv) => toMoney(inv.totalValue).abs()));

        issues.push({
          id: "negative-inventory",
          severity: "critical",
          title: "Negative Inventory Quantities",
          description: `You have ${negativeInventory.length} items with negative quantities. This shouldn't happen and indicates a data issue.`,
          impact: totalNegativeValue.toNumber(),
          howToFix:
            "Create a Production voucher to add the missing quantity back, or review recent Consumption/Sales vouchers that may have removed more than available.",
          category: "Data Integrity",
        });
      }

      // 3. Check for stale OTW containers (in transit for too long)
      const staleContainers = await db
        .select({
          id: containers.id,
          containerNumber: containers.containerNumber,
          grandTotal: containers.grandTotal,
          createdAt: containers.createdAt,
        })
        .from(containers)
        .where(
          and(
            eq(containers.companyId, companyId),
            eq(containers.status, "OTW"),
            sql`${containers.createdAt} < NOW() - INTERVAL '90 days'`
          )
        );

      if (staleContainers.length > 0) {
        const totalStaleValue = sumMoney(staleContainers.map((c) => c.grandTotal));

        issues.push({
          id: "stale-containers",
          severity: "warning",
          title: "Containers In Transit for Over 90 Days",
          description: `You have ${staleContainers.length} container(s) worth $${totalStaleValue.toFixed(2)} that have been "On The Way" for more than 90 days. These may need to be offloaded or marked as lost.`,
          impact: totalStaleValue.toNumber(),
          howToFix:
            "Go to Containers, find the stale containers, and either Offload them to a location if they've arrived, or cancel them if they're lost.",
          category: "Pending Transactions",
        });
      }

      // 4. Check for unbalanced vouchers (debits != credits)
      const unbalancedVouchers = await db
        .select({
          id: vouchers.id,
          voucherNumber: vouchers.voucherNumber,
          voucherType: vouchers.voucherType,
          totalDebits: sql<string>`COALESCE(SUM(CAST(${voucherEntries.debitAmount} AS DECIMAL)), 0)`,
          totalCredits: sql<string>`COALESCE(SUM(CAST(${voucherEntries.creditAmount} AS DECIMAL)), 0)`,
        })
        .from(vouchers)
        .leftJoin(voucherEntries, eq(vouchers.id, voucherEntries.voucherId))
        .where(and(eq(vouchers.companyId, companyId), isNull(vouchers.deletedAt), eq(vouchers.optional, false)))
        .groupBy(vouchers.id, vouchers.voucherNumber, vouchers.voucherType)
        .having(
          sql`ABS(COALESCE(SUM(CAST(${voucherEntries.debitAmount} AS DECIMAL)), 0) - COALESCE(SUM(CAST(${voucherEntries.creditAmount} AS DECIMAL)), 0)) > 0.01`
        );

      if (unbalancedVouchers.length > 0) {
        const totalImbalance = sumMoney(
          unbalancedVouchers.map((v) => toMoney(v.totalDebits).minus(toMoney(v.totalCredits)).abs())
        );

        // Create detailed list of unbalanced vouchers
        const voucherDetails = unbalancedVouchers
          .slice(0, 10)
          .map((v) => {
            const debits = toMoney(v.totalDebits);
            const credits = toMoney(v.totalCredits);
            const diff = debits.minus(credits);
            return `${v.voucherNumber} (${v.voucherType}): DR ${debits.toFixed(2)} - CR ${credits.toFixed(2)} = ${diff.toFixed(2)}`;
          })
          .join("; ");

        issues.push({
          id: "unbalanced-vouchers",
          severity: "critical",
          title: `Unbalanced Voucher Entries (${unbalancedVouchers.length})`,
          description: `${unbalancedVouchers.length} voucher(s) where debits don't equal credits. Total imbalance: ${totalImbalance.toFixed(2)}. Details: ${voucherDetails}${unbalancedVouchers.length > 10 ? "..." : ""}`,
          impact: totalImbalance.toNumber(),
          howToFix:
            "Edit these vouchers in the Daybook to correct the imbalance, ensuring total debits equal total credits.",
          category: "Data Integrity",
        });
      }

      // 5. Check if opening balance equity is significantly off
      const allLedgerAccounts = await db
        .select({
          openingBalance: ledgerAccounts.openingBalance,
          openingBalanceSide: ledgerAccounts.openingBalanceSide,
          accountType: ledgerAccounts.accountType,
        })
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.companyId, companyId), isNull(ledgerAccounts.deletedAt)));

      const drOpenings: string[] = [];
      const crOpenings: string[] = [];
      for (const account of allLedgerAccounts) {
        const openingBalanceRaw = account.openingBalance || "0";
        if (toMoney(openingBalanceRaw).isZero()) continue;
        const openingSide = account.openingBalanceSide || "Dr";
        if (openingSide === "Dr") {
          drOpenings.push(openingBalanceRaw);
        } else {
          crOpenings.push(openingBalanceRaw);
        }
      }
      const totalDrOpenings = sumMoney(drOpenings);
      const totalCrOpenings = sumMoney(crOpenings);

      const openingImbalance = totalDrOpenings.minus(totalCrOpenings).abs();
      if (openingImbalance.gt(100)) {
        issues.push({
          id: "opening-balance-imbalance",
          severity: "info",
          title: "Opening Balance Equity Adjustment",
          description: `Your opening debit balances ($${totalDrOpenings.toFixed(2)}) differ from opening credit balances ($${totalCrOpenings.toFixed(2)}) by $${openingImbalance.toFixed(2)}. This is treated as implicit opening equity.`,
          impact: openingImbalance.toNumber(),
          howToFix:
            "This is often normal when importing data from another system. If you need to balance it, add an opening balance to an Equity or Capital account to offset the difference.",
          category: "Opening Balances",
        });
      }

      // 6. Check for payroll liabilities without matching expenses
      const employeesData = await db
        .select({
          id: employees.id,
          currentBalance: employees.currentBalance,
        })
        .from(employees)
        .where(
          and(
            eq(employees.companyId, companyId),
            isNull(employees.deletedAt),
            sql`CAST(${employees.currentBalance} AS DECIMAL) > 100`
          )
        );

      if (employeesData.length > 0) {
        const totalOwed = sumMoney(employeesData.map((e) => e.currentBalance));

        issues.push({
          id: "employee-balances",
          severity: "info",
          title: "Outstanding Employee Balances",
          description: `You owe ${employeesData.length} employee(s) a total of $${totalOwed.toFixed(2)}. This is recorded as a liability.`,
          impact: totalOwed.toNumber(),
          howToFix:
            "These balances are normal and represent wages owed. Pay employees through Payroll to reduce these liabilities.",
          category: "Liabilities",
        });
      }

      // Check for Loans accounts with a net DEBIT balance (more debits than credits)
      // This is a sign that office charges were posted with the Loans account on the wrong side
      const loansAccounts = await db
        .select({
          id: ledgerAccounts.id,
          name: ledgerAccounts.name,
        })
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.companyId, companyId),
            eq(ledgerAccounts.accountType, "Loans"),
            isNull(ledgerAccounts.deletedAt)
          )
        );

      for (const loanAcct of loansAccounts) {
        const loanEntries = await db
          .select({
            creditAmount: voucherEntries.creditAmount,
            debitAmount: voucherEntries.debitAmount,
          })
          .from(voucherEntries)
          .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
          .where(
            and(
              eq(voucherEntries.ledgerAccountId, loanAcct.id),
              eq(vouchers.companyId, companyId),
              isNull(vouchers.deletedAt),
              eq(vouchers.optional, false)
            )
          );

        const netVoucherBalance = sumMoney(loanEntries.map((e) => e.creditAmount)).minus(
          sumMoney(loanEntries.map((e) => e.debitAmount))
        );

        if (netVoucherBalance.lt(-0.01)) {
          issues.push({
            id: `loans-net-debit-${loanAcct.id}`,
            severity: "warning",
            title: `Loans Account "${loanAcct.name}" Has Net Debit Balance — Office Charges May Be Posted Backwards`,
            description: `The Loans account "${loanAcct.name}" has been debited more than credited (net: $${netVoucherBalance.toFixed(2)}). This usually means office charges were recorded with the Loans account on the DEBIT side instead of the CREDIT side in the Offload dialog.`,
            impact: netVoucherBalance.abs().toNumber(),
            howToFix: `In the Offload dialog, the Loans/credit account should go in the "Cash Account" field (credit side). An expense or import account should go in the "Office Account" field (debit side). Reversing the direction will fix the import cycle balance.`,
            category: "Office Charges",
          });
        }
      }

      // Sort issues by impact (highest first), then by severity
      const severityOrder = { critical: 0, warning: 1, info: 2 };
      issues.sort((a, b) => {
        if (severityOrder[a.severity] !== severityOrder[b.severity]) {
          return severityOrder[a.severity] - severityOrder[b.severity];
        }
        return b.impact - a.impact;
      });

      // Calculate summary
      const criticalCount = issues.filter((i) => i.severity === "critical").length;
      const warningCount = issues.filter((i) => i.severity === "warning").length;
      const totalImpact = sumMoney(issues.map((i) => i.impact)).toNumber();

      res.json({
        issues,
        summary: {
          totalIssues: issues.length,
          criticalCount,
          warningCount,
          totalImpact,
        },
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Sales Report - gain/loss from POS transactions
}
