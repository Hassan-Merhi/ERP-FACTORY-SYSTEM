import type { Express, RequestHandler } from "express";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { companies, vouchers } from "@shared/schema";
import { db } from "../../db";
import { logger } from "../../lib/logger";
import { requireNonPOS } from "../../auth";
import { resolveAllowedGlobalCompanyIds } from "../../services/security/globalCompanyScopeService";
import { getGlobalDaybookFeed } from "./globalDaybookFeed";

function emptyResult(page: number) {
  return { vouchers: [], total: 0, page, totalPages: 0, summary: [], companies: [] };
}

export function registerCentralGlobalTransactionRoutes(app: Express, requireAuth: RequestHandler) {
  app.get("/api/global/transactions", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const role = req.session.currentRole!;
      const {
        startDate,
        endDate,
        companyIds: companyIdsParam,
        voucherType,
        currency,
        search,
        optional: optionalParam,
        includeFactory: includeFactoryParam,
        page: pageParam,
        limit: limitParam,
      } = req.query as Record<string, string>;

      const page = Math.max(1, Number.parseInt(pageParam || "1", 10) || 1);
      const limit = Math.min(200, Math.max(1, Number.parseInt(limitParam || "50", 10) || 50));
      const includeFactory = includeFactoryParam === "true";

      let allowedCompanyIds = await resolveAllowedGlobalCompanyIds(userId, role);
      if (allowedCompanyIds.length === 0) return res.json(emptyResult(page));

      if (!includeFactory) {
        const rows = await db
          .select({ id: companies.id })
          .from(companies)
          .where(
            and(
              inArray(companies.id, allowedCompanyIds),
              or(
                eq(companies.companyType, "erp"),
                eq(companies.companyType, "properties"),
                eq(companies.companyType, "supplier_partner")
              )
            )
          );
        allowedCompanyIds = rows.map((row) => row.id);
        if (allowedCompanyIds.length === 0) return res.json(emptyResult(page));
      }

      let targetCompanyIds = allowedCompanyIds;
      if (companyIdsParam && companyIdsParam !== "all") {
        const requested = companyIdsParam
          .split(",")
          .map((value) => Number.parseInt(value, 10))
          .filter((value) => Number.isSafeInteger(value) && value > 0);
        targetCompanyIds = requested.filter((companyId) => allowedCompanyIds.includes(companyId));
        if (targetCompanyIds.length === 0) return res.json(emptyResult(page));
      }

      // All Daybook is a unified DISPLAY feed: posted vouchers + non-voucher
      // offload events. Accounting entries are never created or adjusted here.
      const journal = await getGlobalDaybookFeed({
        targetCompanyIds,
        startDate,
        endDate,
        voucherType,
        currency,
        optional: optionalParam,
        search,
        page,
        limit,
      });
      const companyRows = await db
        .select({ id: companies.id, name: companies.name })
        .from(companies)
        .where(inArray(companies.id, allowedCompanyIds))
        .orderBy(companies.name);
      return res.json({ ...journal, companies: companyRows });
    } catch (error) {
      logger.error("[CentralGlobalTransactions]", { error });
      return res.status(500).json({ message: "Failed to fetch global transactions" });
    }
  });

  app.get("/api/global/transactions/voucher-types", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const role = req.session.currentRole!;
      const allowedCompanyIds = await resolveAllowedGlobalCompanyIds(userId, role);
      if (allowedCompanyIds.length === 0) return res.json([]);

      const privileged = ["Admin", "Owner", "Manager", "Developer"].includes(role);
      const types = await db
        .selectDistinct({ voucherType: vouchers.voucherType })
        .from(vouchers)
        .where(and(inArray(vouchers.companyId, allowedCompanyIds), ...(privileged ? [] : [isNull(vouchers.deletedAt)])))
        .orderBy(vouchers.voucherType);

      return res.json(types.map((row) => row.voucherType));
    } catch (error) {
      logger.error("[CentralGlobalTransactions/types]", { error });
      return res.status(500).json({ message: "Failed to fetch voucher types" });
    }
  });
}
