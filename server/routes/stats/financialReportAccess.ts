/**
 * Who may read the financial statements (accounting audit phase 27, RP-15).
 *
 * Owner decision (decided by default, owner can override): the trial
 * balance, balance sheet, profit and loss, cash flow, ratios, aging, the
 * period general ledger and consolidation views and their exports are for
 * Admin, Owner and Manager (Developer passes every requireRole). Before, the
 * trial balance was Admin/Owner, the aging Admin/Owner/Manager, the balance
 * sheet and P&L every non-POS user and the ratios every signed-in user (POS
 * users included).
 */
import { requireRole } from "../../auth";

export const FINANCIAL_REPORT_ROLES = ["Admin", "Owner", "Manager"] as const;

export const requireFinancialReportAccess = requireRole(...FINANCIAL_REPORT_ROLES);
