import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../../../../auth";
import { db } from "../../../../db";
import { logger } from "../../../../lib/logger";
import { getErrorMessage } from "../../../../lib/httpHandlers";

/**
 * Read-only matching for uploaded physical bale references.
 * The ordinary /apply endpoint remains the only way to post stock/accounting.
 */
type Match = {
  key: string;
  baleId: number;
  reference: string;
  articleCode: string | null;
  productName: string | null;
  orderId: number;
  invoiceNumber: string;
  containerNumber: string | null;
  customerName: string | null;
  grandTotal: string;
  dispatchBatchId: number | null;
  baleStatus: string;
  baleDeletedAt: Date | null;
  currentLocationId: number | null;
  soldLocationId: number | null;
  balanceCount: number;
  cleanBalanceCount: number;
};
const MAX_REFERENCES = 1000;
const normalized = (reference: string) => reference.trim().toLocaleUpperCase("en-US");

const customerErrors = {
  required: {
    en: "Choose a valid customer before importing references",
    ar: "اختر عميلاً صحيحاً قبل استيراد المراجع",
    fr: "Choisissez un client valide avant d'importer les références",
  },
  notFound: {
    en: "Selected customer not found in this Factory company",
    ar: "العميل المحدد غير موجود في شركة المصنع الحالية",
    fr: "Client sélectionné introuvable dans cette société",
  },
} as const;

function customerError(req: Request, kind: keyof typeof customerErrors): string {
  const requested = String(req.headers["accept-language"] ?? "en").slice(0, 2).toLowerCase();
  const language = requested === "ar" || requested === "fr" ? requested : "en";
  return customerErrors[kind][language];
}

export function registerFinalizedReturnImportPreview(app: Express): void {
  // Lightweight, company-scoped customer picker. No balances or accounting reads.
  app.get(
    "/api/factory/finalized-sale-returns/customers",
    requireAuth,
    requireRole("Admin", "Developer"),
    async (req: Request, res: Response) => {
      try {
        const cid = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!cid) return res.status(400).json({ message: "Select a Factory company" });
        const result = await db.execute(sql`
          SELECT c.id, c.legal_name AS "legalName"
            FROM customers c
           WHERE c.company_id = ${cid}
             AND c.deleted_at IS NULL
           ORDER BY c.legal_name ASC, c.id ASC
        `);
        return res.json(result.rows);
      } catch (error) {
        logger.error("finalized sale return customers lookup failed", { error });
        return res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
  app.post(
    "/api/factory/finalized-sale-returns/import-preview",
    requireAuth,
    requireRole("Admin", "Developer"),
    async (req: Request, res: Response) => {
      try {
        const cid = req.session.factoryCompanyId || req.session.currentCompanyId;
        const raw: unknown = req.body?.references;
        if (!cid) return res.status(400).json({ message: "Select a Factory company" });
        const customerId = req.body?.customerId;
        if (typeof customerId !== "number" || !Number.isSafeInteger(customerId) || customerId <= 0) {
          return res.status(400).json({ message: customerError(req, "required") });
        }
        const customer = await db.execute(sql`
          SELECT c.id, c.legal_name AS "legalName" FROM customers c
           WHERE c.id = ${customerId} AND c.company_id = ${cid} AND c.deleted_at IS NULL
           LIMIT 1
        `);
        if (!customer.rows.length) {
          return res.status(404).json({ message: customerError(req, "notFound") });
        }
        if (
          !Array.isArray(raw) ||
          raw.length < 1 ||
          raw.length > MAX_REFERENCES ||
          raw.some(
            (value: unknown) => typeof value !== "string" || value.trim().length < 1 || value.trim().length > 100
          )
        ) {
          return res
            .status(400)
            .json({ message: "Import 1–1000 non-empty bale reference codes (maximum 100 characters each)" });
        }

        const references = raw.map((value: string) => value.trim());
        const keys = references.map(normalized);
        const counts = new Map<string, number>();
        for (const key of keys) counts.set(key, (counts.get(key) || 0) + 1);
        const unique = [...new Set(keys)];
        const found = await db.execute(sql`
          SELECT UPPER(BTRIM(ob.bale_reference)) AS "key",
                 ob.bale_id AS "baleId", ob.bale_reference AS "reference",
                 ob.article_code AS "articleCode", ob.bale_name AS "productName",
                 o.id AS "orderId", o.invoice_number AS "invoiceNumber",
                 o.container_number AS "containerNumber",
                 c.legal_name AS "customerName", o.grand_total::text AS "grandTotal",
                 o.dispatch_batch_id AS "dispatchBatchId",
                 b.status AS "baleStatus", b.deleted_at AS "baleDeletedAt",
                 b.erp_location_id AS "currentLocationId", ob.location_id AS "soldLocationId",
                 fin.balance_count AS "balanceCount", fin.clean_balance_count AS "cleanBalanceCount"
          FROM customer_order_bales ob
          JOIN customer_orders o ON o.id = ob.order_id
          JOIN factory_bales b ON b.id = ob.bale_id AND b.company_id = o.company_id
          LEFT JOIN customers c ON c.id = o.customer_id AND c.company_id = o.company_id
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::integer AS balance_count,
                   COUNT(*) FILTER (
                     WHERE cb.transaction_type = 'SALE'
                       AND cb.debit_amount = o.grand_total
                       AND cb.balance = o.grand_total
                       AND cb.credit_amount = 0
                   )::integer AS clean_balance_count
            FROM customer_balances cb
            WHERE cb.company_id = o.company_id
              AND cb.reference_type = 'INVOICE'
              AND cb.reference_id = o.id
          ) fin ON TRUE
          WHERE o.company_id = ${cid} AND o.customer_id = ${customerId}
            AND o.deleted_at IS NULL
            AND o.status = 'FINALIZED' AND o.invoice_number IS NOT NULL
            AND (o.previous_status = 'LOADING' OR o.loading_started_at IS NOT NULL OR o.loading_finalized_at IS NOT NULL)
            AND UPPER(BTRIM(ob.bale_reference)) IN (${sql.join(
              unique.map((key) => sql`${key}`),
              sql`, `
            )})
        `);

        const byReference = new Map<string, Match[]>();
        for (const row of found.rows as unknown as Match[]) {
          const list = byReference.get(row.key) ?? [];
          list.push(row);
          byReference.set(row.key, list);
        }
        const rows = references.map((reference, index) => {
          const key = keys[index];
          if (counts.get(key)! > 1)
            return {
              reference,
              status: "duplicate" as const,
              message: "Reference appears more than once in this file",
            };
          const matches = byReference.get(key) || [];
          if (matches.length === 0)
            return {
              reference,
              status: "missing" as const,
              message: "Not found on a finalized loading invoice for the selected customer (or already returned)",
            };
          if (matches.length > 1)
            return {
              reference,
              status: "ambiguous" as const,
              message: "Multiple finalized invoices contain this reference; select manually",
            };
          const match = matches[0];
          let problem: string | null = null;
          if (match.dispatchBatchId) problem = "Invoice has an active dispatch batch; use dispatch-trip reversal";
          else if (match.baleDeletedAt || !["SOLD", "IN_STOCK"].includes(match.baleStatus))
            problem = "Bale has an incompatible physical stock status";
          else if (match.currentLocationId !== match.soldLocationId)
            problem = "Bale changed locations since the finalized sale";
          else if (Number(match.balanceCount) !== 1 || Number(match.cleanBalanceCount) !== 1)
            problem = "Invoice has a paid, adjusted or missing receivable; it cannot be automatically repriced";
          return {
            reference,
            status: problem ? ("blocked" as const) : ("matched" as const),
            message: problem,
            baleId: match.baleId,
            orderId: match.orderId,
            invoiceNumber: match.invoiceNumber,
            containerNumber: match.containerNumber,
            customerName: match.customerName,
            grandTotal: match.grandTotal,
            articleCode: match.articleCode,
            productName: match.productName,
          };
        });
        return res.json({
          customerId,
          customerName: String(customer.rows[0].legalName),
          rows,
          matched: rows.filter((row) => row.status === "matched").length,
          issues: rows.filter((row) => row.status !== "matched").length,
          note: "Matches are a preview only. Dispatch-trip activity, proforma rates and accounting locks are checked again before posting.",
        });
      } catch (error) {
        logger.error("finalized sale return reference import preview failed", { error });
        return res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
