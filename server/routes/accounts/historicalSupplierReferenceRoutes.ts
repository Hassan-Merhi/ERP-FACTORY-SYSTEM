import type { Express } from "express";
import { pool } from "../../db";
import { storage } from "../../storage";
import { requireAuth } from "../../auth";
import { getErrorMessage } from "../../lib/httpHandlers";
import { getAccessibleCompanyIds } from "../../security/companyAccessBoundary";
import { summarizeAccountStatementCurrency } from "../../services/accounting/accountStatementCurrency";
import { higherPriorityTargetsAbsent } from "../../services/accounting/balances/partyLineRules";
import { authorizeCompanyIdParam, getSupplierBalanceForContext } from "../helpers/supplierBalanceHelpers";
import { flagFutureDated, statementWindow } from "../helpers/statementWindow";

/**
 * A row on a supplier statement: either a real voucher entry, or one of the
 * synthetic reference rows this route appends for a child company's historical
 * PO. Deriving it from the storage call keeps the two in step, so a column
 * added there is a type error here rather than a silently missing field.
 */
type SupplierTransactionRow = Awaited<ReturnType<typeof storage.getVoucherEntriesBySupplier>>[number];

const HISTORICAL_REFERENCE_TYPE = "Historical PO Reference";

function statementResponse(transactions: unknown[], fields: Record<string, unknown>) {
  return { transactions, currencySummary: summarizeAccountStatementCurrency(transactions), ...fields };
}

function searchableEntryText(entry: {
  voucherNumber?: string | null;
  voucherDescription?: string | null;
  narration?: string | null;
}) {
  return `${entry.voucherNumber || ""} ${entry.voucherDescription || ""} ${entry.narration || ""}`.toUpperCase();
}

/**
 * Supplier statement compatibility route for legacy linked-child PO imports.
 *
 * Before parent-side PO import posting was introduced, a linked ERP child could
 * post DR Purchases / CR Supplier locally without creating the matching parent
 * DR Child Credit / CR Supplier voucher. Those rows are real historical source
 * documents, but copying their credit into the parent statement would double the
 * already-correct parent supplier balance.
 *
 * When the caller is viewing the parent supplier statement, this route adds a
 * zero-impact informational row for each such child PO. The amount is shown in
 * Particulars, while debit/credit remain zero so opening, period totals, running
 * balance, PDF currency summaries, and the canonical supplier balance are not
 * changed. Modern imports are excluded because their child voucher no longer has
 * a supplier credit, and any PO that already has a parent counterpart is also
 * excluded.
 *
 * Wave 14 (one supplier rule, the posting company): the statement lists the
 * lines the balance engine attributes to the supplier in the company read
 * (partyLineRules ownership: a supplier-tagged line on a ledger account, bank
 * or fixed asset is that account's line), the brought-forward balance counts
 * the same lines, and the response carries the engine's opening with its side
 * (counted only in the supplier's own company) and period opening. The child
 * PO references are added when the company read has linked children
 * (companies.parent_company_id); the global parentCompanyId setting no longer
 * decides anything here.
 */
export function registerHistoricalSupplierReferenceRoutes(app: Express) {
  app.get("/api/accounts/supplier/:id/transactions", requireAuth, async (req, res) => {
    try {
      const supplierId = parseInt(req.params.id);
      if (isNaN(supplierId)) {
        return res.status(400).json({ message: "Invalid supplier ID" });
      }

      // One end-date rule with the balance engine (wave 17 A, statementWindow.ts):
      // an explicit endDate cuts the statement; without one it lists
      // everything posted, like the supplier's balance, and flags the lines
      // dated after the server's business date. It used to stop at the
      // client's today, so the statement did not foot to the balance.
      const { rawStart, effectiveEndDate, asOfDate, businessDate } = statementWindow(req);

      const requestedCompanyId = req.query.companyId ? parseInt(req.query.companyId as string) : undefined;
      const filterCompanyId = await authorizeCompanyIdParam(req, requestedCompanyId);
      // Fail closed on every path that cannot resolve a company, not only on a
      // companyId that was asked for and refused. authorizeCompanyIdParam falls
      // back to req.session.currentCompanyId, which is null for a session that
      // has not selected a company yet, and the balance below reads vouchers
      // with raw SQL: without a company marker that sum would span every
      // company this supplier trades with.
      if (filterCompanyId === null) {
        return res.status(403).json({ message: "No access to this company" });
      }

      const baseTransactions = await storage.getVoucherEntriesBySupplier(
        supplierId,
        filterCompanyId,
        rawStart,
        effectiveEndDate,
        { ownedOnly: true }
      );
      const transactions: SupplierTransactionRow[] = [...baseTransactions];

      if (filterCompanyId && req.session.userId) {
        const accessibleCompanyIds = await getAccessibleCompanyIds(req.session.userId);
        const allCompanies = await storage.getAllCompanies();
        const linkedChildren = allCompanies.filter(
          (company) => company.parentCompanyId === filterCompanyId && accessibleCompanyIds.has(company.id)
        );

        const parentActivityText = baseTransactions.map(searchableEntryText);

        for (const child of linkedChildren) {
          const [purchaseOrders, childSupplierEntries] = await Promise.all([
            storage.getPurchaseOrdersBySupplier(supplierId, child.id),
            storage.getVoucherEntriesBySupplier(supplierId, child.id, rawStart, effectiveEndDate, { ownedOnly: true }),
          ]);

          const entriesByVoucher = new Map<number, typeof childSupplierEntries>();
          for (const entry of childSupplierEntries) {
            const existing = entriesByVoucher.get(entry.voucherId) ?? [];
            existing.push(entry);
            entriesByVoucher.set(entry.voucherId, existing);
          }

          const containers = await Promise.all(purchaseOrders.map((po) => storage.getContainerById(po.containerId)));
          const containerById = new Map(
            containers.filter(Boolean).map((container) => [container!.id, container!] as const)
          );

          for (const po of purchaseOrders) {
            if (!po.voucherId) continue;

            const sourceEntries = entriesByVoucher.get(po.voucherId) ?? [];
            const referenceAmount = sourceEntries.reduce(
              (sum, entry) => sum + parseFloat(entry.creditAmount || "0") - parseFloat(entry.debitAmount || "0"),
              0
            );
            if (referenceAmount <= 0) continue;

            const sourceEntry = sourceEntries[0];
            if (!sourceEntry) continue;

            const container = containerById.get(po.containerId);
            if (!container || container.companyId !== child.id) continue;

            const containerNumber = String(container.containerNumber || "").trim();
            const poNumber = String(po.poNumber || "").trim();
            const containerKey = containerNumber.toUpperCase();
            const poKey = poNumber.toUpperCase();

            const hasParentCounterpart = parentActivityText.some((text) =>
              containerKey ? text.includes(containerKey) : poKey ? text.includes(poKey) : false
            );
            if (hasParentCounterpart) continue;

            const sourceCurrency = sourceEntry.transactionCurrency || sourceEntry.currency || po.currency || "USD";
            const amountLabel = `${sourceCurrency} ${referenceAmount.toLocaleString("en-US", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}`;
            const particular = [containerNumber, poNumber, child.name, amountLabel].filter(Boolean).join(" · ");

            transactions.push({
              entryId: -po.id,
              voucherId: -po.id,
              debitAmount: "0.00",
              creditAmount: "0.00",
              transactionCurrency: sourceCurrency,
              transactionDebitAmount: "0.000000",
              transactionCreditAmount: "0.000000",
              baseDebitAmount: "0.000000",
              baseCreditAmount: "0.000000",
              historicalExchangeRate: sourceEntry.historicalExchangeRate || "1.0000000000",
              rateConvention: sourceEntry.rateConvention || "IDENTITY",
              companyId: filterCompanyId,
              narration: `${particular} · reference only; parent supplier balance unchanged`,
              voucherNumber: poNumber || `PO-${po.id}`,
              voucherType: HISTORICAL_REFERENCE_TYPE,
              voucherDate: sourceEntry.voucherDate,
              voucherDescription: `${particular} · historical child-company PO reference`,
              currency: sourceCurrency,
            });
          }
        }
      }

      transactions.sort((left, right) => {
        const leftDate = String(left.voucherDate || "");
        const rightDate = String(right.voucherDate || "");
        if (leftDate !== rightDate) return rightDate.localeCompare(leftDate);
        return Number(right.voucherId || 0) - Number(left.voucherId || 0);
      });

      let preNetBalance = 0;
      if (rawStart) {
        const bfResult = await pool.query(
          `SELECT COALESCE(SUM(ve.debit_amount::numeric - ve.credit_amount::numeric), 0) AS net
           FROM voucher_entries ve
           JOIN vouchers v ON ve.voucher_id = v.id
           WHERE v.company_id = $3
             AND ve.supplier_id = $1
             AND ${higherPriorityTargetsAbsent("ve", "supplier_id")}
             AND v.optional = false
             AND v.deleted_at IS NULL
             AND COALESCE(v.effective_date::date, v.voucher_date::date) < $2::date`,
          [supplierId, rawStart, filterCompanyId]
        );
        preNetBalance = parseFloat(bfResult.rows[0]?.net ?? "0");
      }

      // The engine's opening (its side, the supplier's own company only) and
      // period opening for the same window.
      const supplier = await storage.getSupplierById(supplierId);
      const engine =
        supplier && !(rawStart && effectiveEndDate && rawStart > effectiveEndDate)
          ? await getSupplierBalanceForContext(supplier, filterCompanyId, {
              startDate: rawStart,
              endDate: effectiveEndDate,
            })
          : null;

      const flagged = flagFutureDated(transactions, businessDate);
      return res.json(
        statementResponse(flagged.rows, {
          openingBalance: engine?.openingBalance ?? 0,
          openingBalanceSide: engine?.openingBalanceSide ?? "Cr",
          periodOpeningBalance: engine?.periodOpeningBalance ?? 0,
          preNetBalance,
          asOfDate,
          startDate: rawStart ?? null,
          endDate: effectiveEndDate ?? null,
          businessDate,
          futureDatedCount: flagged.futureDatedCount,
        })
      );
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
