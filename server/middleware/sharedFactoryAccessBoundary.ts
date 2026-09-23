import type { NextFunction, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { vouchers } from "@shared/schema";
import { resolveFactoryPageKey } from "@shared/factoryAccessRegistry";
import {
  authorizeFactoryPageAccess,
  authorizeFactoryTabAccess,
  getFactoryAccessState,
  sendFactoryAccessDenied,
  type FactoryAccessDecision,
} from "../lib/factoryAccessControl";

export type SharedFactoryRequirement = {
  pageKey: string;
  tabKey?: string;
};

function page(pageKey: string, tabKey?: string): SharedFactoryRequirement {
  return { pageKey, ...(tabKey ? { tabKey } : {}) };
}

const VOUCHERS_PAGE = "factory/vouchers";
const ACCOUNTS_PAGE = "factory/accounts";
const DAYBOOK_PAGE = "factory/daybook";

const VOUCHER_TABS = {
  payment: "hide_tab_vouchers_payment",
  receipt: "hide_tab_vouchers_receipt",
  journal: "hide_tab_vouchers_journal",
  transfer: "hide_tab_vouchers_transfer",
  transferOrder: "hide_tab_vouchers_transferorder",
  adjustment: "hide_tab_vouchers_adjustment",
  creditNote: "hide_tab_vouchers_creditnote",
} as const;

function voucherRequirementsForType(voucherType: unknown): SharedFactoryRequirement[] {
  const value = String(voucherType ?? "").trim().toLowerCase();
  if (value === "payment") return [page(VOUCHERS_PAGE, VOUCHER_TABS.payment)];
  if (value === "receipt") return [page(VOUCHERS_PAGE, VOUCHER_TABS.receipt)];
  if (value === "journal" || value === "contra") return [page(VOUCHERS_PAGE, VOUCHER_TABS.journal)];
  if (value === "stock transfer" || value === "stocktransfer" || value === "transfer") {
    return [
      page(VOUCHERS_PAGE, VOUCHER_TABS.transfer),
      page(VOUCHERS_PAGE, VOUCHER_TABS.transferOrder),
    ];
  }
  if (
    value === "stock adjustment" ||
    value === "production" ||
    value === "consumption" ||
    value === "mixed"
  ) {
    return [page(VOUCHERS_PAGE, VOUCHER_TABS.adjustment)];
  }
  if (value === "credit note" || value === "debit note") {
    return [page(VOUCHERS_PAGE, VOUCHER_TABS.creditNote)];
  }
  return [page(VOUCHERS_PAGE)];
}

async function existingVoucherRequirements(
  req: Request,
  voucherId: number
): Promise<SharedFactoryRequirement[]> {
  const state = await getFactoryAccessState(req);
  if (!state) return [page(VOUCHERS_PAGE)];

  const [row] = await db
    .select({ voucherType: vouchers.voucherType })
    .from(vouchers)
    .where(and(eq(vouchers.id, voucherId), eq(vouchers.companyId, state.companyId)))
    .limit(1);

  return row ? voucherRequirementsForType(row.voucherType) : [page(VOUCHERS_PAGE)];
}

/**
 * Classifies only shared ERP endpoints that are used by Factory Accounts/Vouchers.
 * Ordinary ERP/POS callers remain on their existing permission path unless they
 * explicitly identify as Factory mode or the user is Factory-only.
 */
export async function resolveSharedFactoryRequirements(req: Request): Promise<SharedFactoryRequirement[] | null> {
  const path = req.originalUrl.split("?", 1)[0] || req.path;
  const method = req.method.toUpperCase();

  if (
    path === "/api/accounts" ||
    path.startsWith("/api/accounts/") ||
    path === "/api/ledger-accounts" ||
    path.startsWith("/api/ledger-accounts/") ||
    path === "/api/bank-accounts" ||
    path.startsWith("/api/bank-accounts/")
  ) {
    if (path.startsWith("/api/accounts/voucher-sidebar")) {
      return [
        page(ACCOUNTS_PAGE, "hide_tab_accounts_view"),
        page(VOUCHERS_PAGE),
      ];
    }
    return [
      page(ACCOUNTS_PAGE, "hide_tab_accounts_view"),
      page(VOUCHERS_PAGE),
      page("factory/payroll-hub"),
      page("factory/import"),
      page("factory/settings"),
    ];
  }

  if (path === "/api/daybook" || path.startsWith("/api/daybook/")) {
    return [page(DAYBOOK_PAGE, "hide_tab_daybook_transactions")];
  }

  if (path.startsWith("/api/credit-notes")) {
    return [page(VOUCHERS_PAGE, VOUCHER_TABS.creditNote)];
  }

  if (path.startsWith("/api/stock-adjustments")) {
    return [page(VOUCHERS_PAGE, VOUCHER_TABS.adjustment)];
  }

  if (
    path.startsWith("/api/stock-transfers") ||
    path.startsWith("/api/stock-transfer-revisions") ||
    path.startsWith("/api/stock-transfer-import")
  ) {
    return [
      page(VOUCHERS_PAGE, VOUCHER_TABS.transfer),
      page(VOUCHERS_PAGE, VOUCHER_TABS.transferOrder),
    ];
  }

  if (path.startsWith("/api/voucher-entries") || path.startsWith("/api/voucher-detail")) {
    return [
      page(VOUCHERS_PAGE),
      page(ACCOUNTS_PAGE, "hide_tab_accounts_view"),
      page(ACCOUNTS_PAGE, "hide_tab_accounts_find_voucher"),
      page(DAYBOOK_PAGE, "hide_tab_daybook_transactions"),
    ];
  }

  if (path === "/api/vouchers/bulk-delete") {
    return [
      page(VOUCHERS_PAGE),
      page(ACCOUNTS_PAGE, "hide_tab_accounts_view"),
    ];
  }

  if (path === "/api/vouchers/search" || path.startsWith("/api/vouchers/search/")) {
    return [
      page(ACCOUNTS_PAGE, "hide_tab_accounts_find_voucher"),
      page(VOUCHERS_PAGE),
    ];
  }

  if (path === "/api/vouchers/payment-receipt" || /^\/api\/vouchers\/\d+\/payment-receipt$/.test(path)) {
    const type = String(req.body?.voucherType ?? "").toLowerCase();
    if (type === "payment") return [page(VOUCHERS_PAGE, VOUCHER_TABS.payment)];
    if (type === "receipt") return [page(VOUCHERS_PAGE, VOUCHER_TABS.receipt)];
    return [
      page(VOUCHERS_PAGE, VOUCHER_TABS.payment),
      page(VOUCHERS_PAGE, VOUCHER_TABS.receipt),
    ];
  }

  if (
    path === "/api/vouchers/journal" ||
    path.startsWith("/api/vouchers/journal/") ||
    path === "/api/vouchers/journal-entries" ||
    path.startsWith("/api/vouchers/journal-entries/")
  ) {
    return [page(VOUCHERS_PAGE, VOUCHER_TABS.journal)];
  }

  if (path === "/api/vouchers/with-entries") {
    return voucherRequirementsForType(req.body?.voucher?.voucherType ?? req.body?.voucherType ?? "Journal");
  }

  if (path === "/api/vouchers" && method === "POST") {
    return voucherRequirementsForType(req.body?.voucherType);
  }

  const voucherIdMatch = path.match(/^\/api\/vouchers\/(\d+)(?:\/.*)?$/);
  if (voucherIdMatch && !["GET", "HEAD", "OPTIONS"].includes(method)) {
    return existingVoucherRequirements(req, Number(voucherIdMatch[1]));
  }

  if (path === "/api/vouchers" || path.startsWith("/api/vouchers/")) {
    return [
      page(VOUCHERS_PAGE),
      page(ACCOUNTS_PAGE, "hide_tab_accounts_view"),
      page(ACCOUNTS_PAGE, "hide_tab_accounts_find_voucher"),
      page(DAYBOOK_PAGE, "hide_tab_daybook_transactions"),
    ];
  }

  return null;
}

function ownerMismatch(): Exclude<FactoryAccessDecision, { allowed: true }> {
  return {
    allowed: false,
    code: "FACTORY_PAGE_ACCESS_DENIED",
    message: "This shared API is not owned by the current Factory page.",
  };
}

async function evaluateRequirement(req: Request, rule: SharedFactoryRequirement): Promise<FactoryAccessDecision> {
  return rule.tabKey
    ? authorizeFactoryTabAccess(req, rule.pageKey, rule.tabKey)
    : authorizeFactoryPageAccess(req, rule.pageKey);
}

export async function enforceSharedFactoryAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.session?.userId) {
    next();
    return;
  }

  try {
    const requirements = await resolveSharedFactoryRequirements(req);
    if (!requirements) {
      next();
      return;
    }

    const factoryMode = String(req.get("X-App-Mode") || "").toLowerCase() === "factory";
    const state = await getFactoryAccessState(req);
    if (!state) {
      if (factoryMode) {
        sendFactoryAccessDenied(res, {
          allowed: false,
          code: "FACTORY_ACCESS_CONTEXT_MISSING",
          message: "Factory access context is unavailable.",
        });
        return;
      }
      next();
      return;
    }

    // Normal ERP/POS callers keep their existing authorization path. Factory-only
    // accounts cannot bypass Factory restrictions by stripping the mode header.
    if (!factoryMode && state.hasErpAccess) {
      next();
      return;
    }

    let candidates = requirements;
    if (factoryMode) {
      const requestedFactoryPath = String(req.get("X-Factory-Page") || "");
      const currentPageKey = requestedFactoryPath ? resolveFactoryPageKey(requestedFactoryPath) : null;
      if (!currentPageKey) {
        sendFactoryAccessDenied(res, ownerMismatch());
        return;
      }
      candidates = requirements.filter((rule) => rule.pageKey === currentPageKey);
      if (candidates.length === 0) {
        sendFactoryAccessDenied(res, ownerMismatch());
        return;
      }
    }

    let firstDenied: Exclude<FactoryAccessDecision, { allowed: true }> | null = null;
    for (const candidate of candidates) {
      const decision = await evaluateRequirement(req, candidate);
      if (decision.allowed) {
        next();
        return;
      }
      firstDenied ??= decision;
      if (decision.code === "FACTORY_ACCESS_DISABLED") break;
    }

    sendFactoryAccessDenied(res, firstDenied ?? ownerMismatch());
  } catch (error) {
    next(error);
  }
}
