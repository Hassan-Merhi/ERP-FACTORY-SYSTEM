import type { Express, NextFunction, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { and, eq, inArray, or } from "drizzle-orm";
import { requireAuth } from "../../auth";
import { db, pool } from "../../db";
import { buildPaginationIntegrityConditions } from "../../services/factory/daybookSourceIntegrity";
import { factoryBaleProducts, factoryBales, factoryUserProfiles } from "@shared/schema";

const MAX_PAGE_SIZE = 250;
const DEFAULT_PAGE_SIZE = 100;

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function wantsPagination(req: Request): boolean {
  return (
    req.query.pagination === "1" ||
    req.query.page !== undefined ||
    req.query.limit !== undefined ||
    req.query.pageSize !== undefined ||
    req.query.offset !== undefined
  );
}

function parsePagination(req: Request): { page: number; limit: number; offset: number } {
  const limit = Math.min(MAX_PAGE_SIZE, parsePositiveInt(req.query.limit ?? req.query.pageSize, DEFAULT_PAGE_SIZE));
  if (req.query.offset !== undefined) {
    const offset = Math.max(0, Number.parseInt(String(req.query.offset), 10) || 0);
    return { page: Math.floor(offset / limit) + 1, limit, offset };
  }
  const page = parsePositiveInt(req.query.page, 1);
  return { page, limit, offset: (page - 1) * limit };
}

function normalizeDateFilter(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

type BaleStockDaybookRow = {
  id: number;
  txType: string | null;
  metaJson: string | null;
  amountCurrency: string | null;
  amountUsd: string | null;
};

async function deriveBaleStockEntryAmounts(rows: BaleStockDaybookRow[], companyId: number): Promise<void> {
  const baleRows = rows.filter((row) => row.txType === "BALE_STOCK_ENTRY" && row.metaJson);
  if (baleRows.length === 0) return;

  const baleIdToRows = new Map();
  for (const row of baleRows) {
    try {
      const meta = JSON.parse(row.metaJson || "{}");
      const bales = Array.isArray(meta.bales) ? meta.bales : [];
      for (const bale of bales) {
        const id = Number.parseInt(String(bale.id), 10);
        if (!Number.isInteger(id) || String(id) !== String(bale.id)) continue;
        const linked = baleIdToRows.get(id) ?? [];
        linked.push(row);
        baleIdToRows.set(id, linked);
      }
    } catch {
      // Preserve the stored amount when legacy metadata cannot be parsed.
    }
  }
  if (baleIdToRows.size === 0) return;

  const baleRecords = await db
    .select({
      id: factoryBales.id,
      productId: factoryBales.productId,
      articleCode: factoryBales.articleCode,
    })
    .from(factoryBales)
    .where(inArray(factoryBales.id, [...baleIdToRows.keys()]));

  const productIds = [...new Set(baleRecords.map((row) => row.productId).filter((id): id is number => id != null))];
  const articleCodes = [
    ...new Set(baleRecords.map((row) => row.articleCode).filter((code): code is string => Boolean(code))),
  ];

  const productMatches = [];
  if (productIds.length > 0) productMatches.push(inArray(factoryBaleProducts.id, productIds));
  if (articleCodes.length > 0) productMatches.push(inArray(factoryBaleProducts.articleCode, articleCodes));

  const products =
    productMatches.length === 0
      ? []
      : await db
          .select({
            id: factoryBaleProducts.id,
            articleCode: factoryBaleProducts.articleCode,
            productionPrice: factoryBaleProducts.productionPrice,
          })
          .from(factoryBaleProducts)
          .where(
            and(
              eq(factoryBaleProducts.companyId, companyId),
              productMatches.length === 1 ? productMatches[0] : or(...productMatches)!
            )
          );

  const priceByProductId = new Map<number, number>();
  const priceByArticleCode = new Map<string, number>();
  for (const product of products) {
    const price = Number.parseFloat(product.productionPrice || "0") || 0;
    priceByProductId.set(product.id, price);
    if (product.articleCode) priceByArticleCode.set(product.articleCode, price);
  }

  const rowTotals = new Map<number, number>();
  for (const bale of baleRecords) {
    let price = bale.productId ? priceByProductId.get(bale.productId) || 0 : 0;
    if (price === 0 && bale.articleCode) price = priceByArticleCode.get(bale.articleCode) || 0;
    for (const row of baleIdToRows.get(bale.id) ?? []) {
      rowTotals.set(row.id, (rowTotals.get(row.id) || 0) + price);
    }
  }

  for (const row of baleRows) {
    const derived = rowTotals.get(row.id);
    if (derived && derived > 0) {
      row.amountCurrency = derived.toFixed(2);
      row.amountUsd = derived.toFixed(2);
    }
  }
}

export function registerFactoryDaybookPaginationRoutes(app: Express): void {
  app.get("/api/factory/daybook", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    if (!wantsPagination(req)) return next();

    try {
      const session = req.session;
      const companyId = session.factoryCompanyId || session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const currentUserId = session.userId != null ? String(session.userId) : undefined;
      const role = String(session.currentRole || session.role || "");
      const elevatedRole = ["Admin", "Owner", "Developer", "View Only"].includes(role);

      let ownOnly = false;
      if (currentUserId) {
        const [profile] = await db
          .select({ hiddenCostFields: factoryUserProfiles.hiddenCostFields })
          .from(factoryUserProfiles)
          .where(and(eq(factoryUserProfiles.companyId, companyId), eq(factoryUserProfiles.userId, currentUserId)));
        ownOnly = Boolean(profile?.hiddenCostFields?.includes("daybook_own_only"));
      }

      let startDate = normalizeDateFilter(req.query.startDate);
      let endDate = normalizeDateFilter(req.query.endDate);
      if (req.query.startDate === undefined && req.query.endDate === undefined) {
        const today = new Date().toISOString().slice(0, 10);
        startDate = today;
        endDate = today;
      }

      const txType = typeof req.query.txType === "string" && req.query.txType !== "ALL" ? req.query.txType : undefined;
      const currencyCode =
        typeof req.query.currencyCode === "string" && req.query.currencyCode !== "ALL"
          ? req.query.currencyCode
          : undefined;
      const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
      const optionalStatus = String(req.query.optionalStatus ?? req.query.statusFilter ?? "all");
      const minAmount = Number.parseFloat(String(req.query.minAmount ?? ""));
      const maxAmount = Number.parseFloat(String(req.query.maxAmount ?? ""));
      const sortDirection = req.query.sortOrder === "asc" ? "ASC" : "DESC";
      const { page, limit, offset } = parsePagination(req);

      const values: unknown[] = [];
      const bind = (value: unknown): string => {
        values.push(value);
        return `$${values.length}`;
      };

      const companyParam = bind(companyId);
      const realConditions = [
        `f.company_id = ${companyParam}`,
        `f.tx_type NOT LIKE '%_VOIDED'`,
        `f.tx_type NOT LIKE '%_DELETED'`,
        `f.tx_type NOT IN ('LOADING_SUBMITTED','ORDER_VERIFIED','INVOICE_REVERTED','SUPPLIER_FX_TRANSFER_DELETE','WORKER_CREATED','ORDER_CANCELLED','CONTRACT_SETTLED','CONTRACT_REACTIVATED','CONTRACT_ENDED')`,
        `NOT (f.tx_type = 'PAYROLL_PAYMENT' AND COALESCE(f.amount_currency, 0) = 0)`,
        `(f.reference_table IS DISTINCT FROM 'vouchers' OR f.reference_id IS NULL OR live_voucher.id IS NOT NULL)`,
        // Shared source-integrity conditions — generated from the central registry.
        // Covers all source-backed txTypes (payrolls, advances, repayments, containers,
        // mix batches, customer orders, commissions, raw stock, etc.).
        ...buildPaginationIntegrityConditions(companyParam),
      ];
      const voucherConditions = [
        `v.company_id = ${companyParam}`,
        `v.deleted_at IS NULL`,
        `v.voucher_type IN ('Payment','Receipt','Journal')`,
      ];

      if (startDate) {
        const param = bind(startDate);
        realConditions.push(`f.tx_date >= ${param}::date`);
        voucherConditions.push(`COALESCE(v.effective_date, v.voucher_date) >= ${param}::date`);
      }
      if (endDate) {
        const param = bind(endDate);
        realConditions.push(`f.tx_date <= ${param}::date`);
        voucherConditions.push(`COALESCE(v.effective_date, v.voucher_date) <= ${param}::date`);
      }
      if (txType) {
        const param = bind(txType);
        realConditions.push(`f.tx_type = ${param}`);
        voucherConditions.push(
          `(CASE v.voucher_type WHEN 'Payment' THEN 'PAYMENT' WHEN 'Receipt' THEN 'RECEIPT' ELSE 'JOURNAL' END) = ${param}`
        );
      }
      if (currencyCode) {
        const param = bind(currencyCode);
        realConditions.push(`f.currency_code = ${param}`);
        voucherConditions.push(`v.currency = ${param}`);
      }

      if (!elevatedRole && currentUserId) {
        realConditions.push(`f.created_by = ${bind(currentUserId)}`);
      } else if (ownOnly && currentUserId) {
        const param = bind(currentUserId);
        realConditions.push(`(f.created_by = ${param} OR f.created_by IS NULL)`);
      }

      const canSeeSynthetic = elevatedRole && !ownOnly;
      voucherConditions.push(`${bind(canSeeSynthetic)}::boolean`);
      voucherConditions.push(
        `NOT EXISTS (SELECT 1 FROM factory_daybook_entries captured WHERE captured.company_id = v.company_id AND captured.reference_table = 'vouchers' AND captured.reference_id = v.id)`
      );

      const outerConditions = [`dedup_rank = 1`];
      if (search) {
        const param = bind(`%${search}%`);
        outerConditions.push(`(description ILIKE ${param} OR "txType" ILIKE ${param})`);
      }
      if (optionalStatus === "exclude") outerConditions.push(`optional = false`);
      else if (optionalStatus === "only") outerConditions.push(`optional = true`);
      if (Number.isFinite(minAmount)) outerConditions.push(`"amountCurrency"::numeric >= ${bind(minAmount)}`);
      if (Number.isFinite(maxAmount)) outerConditions.push(`"amountCurrency"::numeric <= ${bind(maxAmount)}`);

      const limitParam = bind(limit);
      const offsetParam = bind(offset);

      const query = `
          WITH real_rows AS (
            SELECT
              f.id,
              f.company_id AS "companyId",
              f.tx_date::text AS "txDate",
              f.tx_type AS "txType",
              f.reference_id AS "referenceId",
              f.reference_table AS "referenceTable",
              CASE
                WHEN f.reference_table = 'vouchers' AND live_voucher.id IS NOT NULL
                  THEN COALESCE(live_voucher.description, live_voucher.voucher_type || ' voucher #' || live_voucher.voucher_number)
                ELSE f.description
              END AS description,
              f.meta_json AS "metaJson",
              f.currency_code AS "currencyCode",
              CASE
                WHEN f.reference_table = 'vouchers' AND live_voucher.id IS NOT NULL THEN live_voucher.total_amount::text
                ELSE f.amount_currency::text
              END AS "amountCurrency",
              CASE
                WHEN f.reference_table = 'vouchers' AND live_voucher.id IS NOT NULL
                  THEN COALESCE(NULLIF(live_voucher.exchange_rate, 0), 1)::text
                ELSE f.fx_rate_to_usd::text
              END AS "fxRateToUsd",
              CASE
                WHEN f.reference_table = 'vouchers' AND live_voucher.id IS NOT NULL THEN
                  CASE
                    WHEN live_voucher.currency = 'USD' THEN live_voucher.total_amount::text
                    ELSE (live_voucher.total_amount * COALESCE(NULLIF(live_voucher.exchange_rate, 0), 1))::text
                  END
                ELSE f.amount_usd::text
              END AS "amountUsd",
              CASE
                WHEN f.reference_table = 'vouchers' AND live_voucher.id IS NOT NULL
                  THEN COALESCE(live_voucher.effective_date, f.effective_date)::text
                ELSE f.effective_date::text
              END AS "effectiveDate",
              f.created_at AS "createdAt",
              f.created_by AS "createdBy",
              CASE
                WHEN f.reference_table = 'vouchers' AND live_voucher.id IS NOT NULL THEN COALESCE(live_voucher.optional, false)
                ELSE false
              END AS optional,
              CASE
                WHEN f.reference_table = 'vouchers' AND live_voucher.id IS NOT NULL THEN live_voucher.voucher_number
                ELSE NULL
              END AS "voucherNumber",
              COALESCE(
                CASE WHEN f.reference_table = 'vouchers' AND live_voucher.id IS NOT NULL THEN live_voucher.effective_date ELSE f.effective_date END,
                f.tx_date
              ) AS sort_date
            FROM factory_daybook_entries f
            LEFT JOIN vouchers live_voucher
              ON f.reference_table = 'vouchers'
             AND live_voucher.id = f.reference_id
             AND live_voucher.deleted_at IS NULL
            WHERE ${realConditions.join(" AND ")}
          ),
          synthetic_rows AS (
            SELECT
              -v.id AS id,
              v.company_id AS "companyId",
              COALESCE(v.effective_date, v.voucher_date)::text AS "txDate",
              CASE v.voucher_type WHEN 'Payment' THEN 'PAYMENT' WHEN 'Receipt' THEN 'RECEIPT' ELSE 'JOURNAL' END AS "txType",
              v.id AS "referenceId",
              'vouchers'::text AS "referenceTable",
              COALESCE(v.description, v.voucher_type || ' voucher #' || v.voucher_number) AS description,
              NULL::text AS "metaJson",
              v.currency AS "currencyCode",
              v.total_amount::text AS "amountCurrency",
              COALESCE(NULLIF(v.exchange_rate, 0), 1)::text AS "fxRateToUsd",
              CASE
                WHEN v.currency = 'USD' THEN v.total_amount::text
                ELSE (v.total_amount * COALESCE(NULLIF(v.exchange_rate, 0), 1))::text
              END AS "amountUsd",
              v.effective_date::text AS "effectiveDate",
              v.created_at AS "createdAt",
              NULL::text AS "createdBy",
              COALESCE(v.optional, false) AS optional,
              v.voucher_number AS "voucherNumber",
              COALESCE(v.effective_date, v.voucher_date) AS sort_date
            FROM vouchers v
            WHERE ${voucherConditions.join(" AND ")}
          ),
          combined AS (
            SELECT * FROM real_rows
            UNION ALL
            SELECT * FROM synthetic_rows
          ),
          ranked AS (
            SELECT
              combined.*,
              CASE
                WHEN "txType" IN ('INVOICE','INVOICE_REVERTED','ORDER_VERIFIED','ORDER_CANCELLED') AND "referenceId" IS NOT NULL
                  THEN ROW_NUMBER() OVER (PARTITION BY "txType", "referenceId" ORDER BY ABS(id) DESC)
                ELSE 1
              END AS dedup_rank
            FROM combined
          ),
          filtered AS (
            SELECT * FROM ranked WHERE ${outerConditions.join(" AND ")}
          ),
          page_rows AS (
            SELECT
              id, "companyId", "txDate", "txType", "referenceId", "referenceTable", description,
              "metaJson", "currencyCode", "amountCurrency", "fxRateToUsd", "amountUsd", "effectiveDate",
              "createdAt", "createdBy", optional, "voucherNumber", sort_date
            FROM filtered
            ORDER BY sort_date ${sortDirection}, ABS(id) ${sortDirection}
            LIMIT ${limitParam} OFFSET ${offsetParam}
          )
          SELECT
            (SELECT COUNT(*)::int FROM filtered) AS total,
            COALESCE(
              (
                SELECT jsonb_agg(to_jsonb(page_rows) - 'sort_date' ORDER BY sort_date ${sortDirection}, ABS(id) ${sortDirection})
                FROM page_rows
              ),
              '[]'::jsonb
            ) AS items
        `;

      const result = await pool.query(query, values);
      const total = Number(result.rows[0]?.total || 0);
      const items = Array.isArray(result.rows[0]?.items) ? result.rows[0].items : [];
      await deriveBaleStockEntryAmounts(items as BaleStockDaybookRow[], companyId);

      const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
      res.setHeader("X-Total-Count", String(total));
      res.setHeader("X-Page", String(page));
      res.setHeader("X-Page-Size", String(limit));
      res.setHeader("X-Total-Pages", String(totalPages));
      res.setHeader("Access-Control-Expose-Headers", "X-Total-Count, X-Page, X-Page-Size, X-Total-Pages");

      return res.json({
        items,
        total,
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1 && totalPages > 0,
      });
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
