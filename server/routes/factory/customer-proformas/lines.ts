/**
 * factoryCustomerProformaRoutes: FactoryCustomerProformaLine endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { syncProformaReservations, isFactoryV2Company, computeFreeToPromise } from "../_stockReservationHelper";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { customerProformaLines, insertCustomerProformaLineSchema } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { validateRequest, validatedInput } from "../../../lib/validateRequest";
import { createProformaLineInput, deleteProformaLineInput } from "./customerProformaRouteSchemas";
import {
  registerFactoryCustomerProformaLineRoutesPart1,
  proformaInCompany,
} from "./registerFactoryCustomerProformaLineRoutesPart1";

export function registerFactoryCustomerProformaLineRoutes(app: Express) {
  app.post(
    "/api/factory/customer-proforma-lines",
    requireAuth,
    validateRequest(createProformaLineInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const parsed = insertCustomerProformaLineSchema.parse(req.body);
        if (!(await proformaInCompany(parsed.proformaId, companyId))) {
          return res.status(404).json({ message: "Proforma not found" });
        }

        const [existingLine] = await db
          .select()
          .from(customerProformaLines)
          .where(
            and(
              eq(customerProformaLines.proformaId, parsed.proformaId),
              sql`LOWER(TRIM(${customerProformaLines.articleCode})) = ${parsed.articleCode.trim().toLowerCase()}`
            )
          );
        if (existingLine) return res.status(400).json({ message: "Article code already exists in this proforma" });

        // factory_v2: warn if requested quantity exceeds free-to-promise (non-blocking)
        let stockWarning: string | undefined;
        if (await isFactoryV2Company(companyId)) {
          const ftp = await computeFreeToPromise(companyId, parsed.articleCode);
          if ((parsed.quantity ?? 0) > ftp) {
            stockWarning = `Insufficient free stock for ${parsed.articleCode}: requested ${parsed.quantity}, available ${ftp}`;
          }
        }

        // New proforma articles must also appear in the expected plan of
        // unfinished linked loadings. The snapshot previously stayed frozen,
        // so verification showed a scanned new article as "Not Requested".
        // Preserve all existing per-loading quantities and finalized history.
        const [line] = await db.transaction(async (tx) => {
          const [inserted] = await tx.insert(customerProformaLines).values(parsed).returning();
          await tx.execute(sql`
          INSERT INTO customer_order_expected_lines
            (company_id, order_id, proforma_id, proforma_line_id, article_code, product_name, expected_qty)
          SELECT
            ${companyId}, co.id, ${parsed.proformaId}, ${inserted.id},
            ${inserted.articleCode}, ${inserted.productName}, ${inserted.quantity}
          FROM customer_orders co
          WHERE co.company_id = ${companyId}
            AND co.proforma_id_used = ${parsed.proformaId}
            AND co.status IN ('LOADING', 'PENDING_VERIFICATION')
            AND co.deleted_at IS NULL
            AND EXISTS (
              SELECT 1 FROM factory_daybook_entries event
              WHERE event.company_id = ${companyId}
                AND event.reference_table = 'customer_orders'
                AND event.reference_id = co.id
                AND event.tx_type = 'LOADING_CREATED'
                AND event.description LIKE 'Loading started for customer:%'
            )
            AND NOT EXISTS (
              SELECT 1 FROM customer_order_expected_lines expected
              WHERE expected.company_id = ${companyId}
                AND expected.order_id = co.id
                AND LOWER(TRIM(expected.article_code)) = LOWER(TRIM(${inserted.articleCode}))
            )
          ON CONFLICT (order_id, article_code) DO NOTHING
        `);
          return [inserted];
        });
        // Sync — new line changes reservedNotYetLoaded for this proforma
        await syncProformaReservations(db, companyId, parsed.proformaId);

        // Proforma prices are document-specific. The customer agreed-price
        // list changes only through explicit price-list actions.

        res.json({ ...line, ...(stockWarning ? { stockWarning } : {}) });
      } catch (error: unknown) {
        logger.error("Error creating proforma line:", { error: error });
        res.status(400).json({ message: getErrorMessage(error) });
      }
    }
  );

  registerFactoryCustomerProformaLineRoutesPart1(app);

  app.delete(
    "/api/factory/customer-proforma-lines/:id",
    requireAuth,
    validateRequest(deleteProformaLineInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const { id } = validatedInput(req, deleteProformaLineInput).params;

        // Fetch the line first to get its proformaId before deletion
        const [lineToDelete] = await db
          .select()
          .from(customerProformaLines)
          .where(eq(customerProformaLines.id, id))
          .limit(1);
        if (!lineToDelete || !(await proformaInCompany(lineToDelete.proformaId, companyId))) {
          return res.status(404).json({ message: "Proforma line not found" });
        }

        const [deleted] = await db.delete(customerProformaLines).where(eq(customerProformaLines.id, id)).returning();
        if (!deleted) return res.status(404).json({ message: "Proforma line not found" });
        // Sync — removed line releases its reservation
        await syncProformaReservations(db, companyId, lineToDelete.proformaId);
        res.json({ message: "Proforma line deleted" });
      } catch (error: unknown) {
        logger.error("Error deleting proforma line:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
