import { punctuationInsensitiveSearch } from "../../lib/searchNormalization";
import { normalizeSearchText } from "@shared/searchNormalization";
import type { Express, RequestHandler } from "express";
import { and, asc, count, desc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { companies, voucherEntries, vouchers } from "@shared/schema";
import { db } from "../../db";
import { logger } from "../../lib/logger";
import { requireNonPOS } from "../../auth";
import { resolveAllowedGlobalCompanyIds } from "../../services/security/globalCompanyScopeService";

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
      const offset = (page - 1) * limit;
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

      const conditions: (SQL | undefined)[] = [
        inArray(vouchers.companyId, targetCompanyIds),
        isNull(vouchers.deletedAt),
      ];
      if (startDate) conditions.push(gte(vouchers.voucherDate, startDate));
      if (endDate) conditions.push(lte(vouchers.voucherDate, endDate));
      if (voucherType && voucherType !== "all") {
        if (voucherType === "Stock Transfer" || voucherType === "StockTransfer") {
          conditions.push(or(eq(vouchers.voucherType, "Stock Transfer"), eq(vouchers.voucherType, "StockTransfer")));
        } else {
          conditions.push(eq(vouchers.voucherType, voucherType));
        }
      }
      if (currency && currency !== "all") conditions.push(eq(vouchers.currency, currency));
      if (optionalParam === "active") conditions.push(eq(vouchers.optional, false));
      if (optionalParam === "optional") conditions.push(eq(vouchers.optional, true));
      if (search) {
        conditions.push(
          or(
            punctuationInsensitiveSearch(vouchers.voucherNumber, String(search)),
            punctuationInsensitiveSearch(vouchers.description, String(search)),
            sql`EXISTS (
              SELECT 1 FROM voucher_entries ve
              WHERE ve.voucher_id = ${vouchers.id}
              AND (
                ve.narration ILIKE ${`%${search}%`}
                OR regexp_replace(lower(COALESCE(ve.narration, '')), '[^[:alnum:]]+', '', 'g')
                  LIKE ${`%${normalizeSearchText(search)}%`}
              )
            )`
          )
        );
      }

      const whereClause = and(...conditions);
      const [{ total }] = await db.select({ total: count() }).from(vouchers).where(whereClause);
      const totalCount = Number(total);
      const totalPages = Math.ceil(totalCount / limit);

      const rows = await db
        .select({
          id: vouchers.id,
          companyId: vouchers.companyId,
          companyName: companies.name,
          voucherNumber: vouchers.voucherNumber,
          voucherType: vouchers.voucherType,
          voucherDate: vouchers.voucherDate,
          totalAmount: vouchers.totalAmount,
          currency: vouchers.currency,
          optional: vouchers.optional,
          description: vouchers.description,
          deletedAt: vouchers.deletedAt,
          narration: sql<string>`(
            SELECT ve.narration FROM voucher_entries ve
            WHERE ve.voucher_id = ${vouchers.id}
            AND ve.narration IS NOT NULL AND ve.narration != ''
            LIMIT 1
          )`,
        })
        .from(vouchers)
        .innerJoin(companies, eq(companies.id, vouchers.companyId))
        .where(whereClause)
        .orderBy(asc(companies.name), desc(vouchers.voucherDate), desc(vouchers.id))
        .limit(limit)
        .offset(offset);

      const summaryRows = await db
        .select({
          companyId: vouchers.companyId,
          companyName: companies.name,
          currency: vouchers.currency,
          voucherCount: count(),
          totalDebits: sql<string>`SUM(CASE WHEN ${voucherEntries.debitAmount} > 0 THEN ${voucherEntries.debitAmount} ELSE 0 END)`,
          totalCredits: sql<string>`SUM(CASE WHEN ${voucherEntries.creditAmount} > 0 THEN ${voucherEntries.creditAmount} ELSE 0 END)`,
        })
        .from(vouchers)
        .innerJoin(companies, eq(companies.id, vouchers.companyId))
        .innerJoin(voucherEntries, eq(voucherEntries.voucherId, vouchers.id))
        .where(whereClause)
        .groupBy(vouchers.companyId, companies.name, vouchers.currency)
        .orderBy(companies.name);

      const companyRows = await db
        .select({ id: companies.id, name: companies.name })
        .from(companies)
        .where(inArray(companies.id, allowedCompanyIds))
        .orderBy(companies.name);

      return res.json({
        vouchers: rows,
        total: totalCount,
        page,
        totalPages,
        summary: summaryRows,
        companies: companyRows,
      });
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
