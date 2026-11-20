/**
 * deletedItemsRoutes: DeletedItemsPermanentDelete endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage, errorStatus } from "../../../lib/httpHandlers";
import { requireAuth, requireNonPOS } from "../../../auth";
import { z } from "zod";
import { emptyBody, emptyQuery, stringParam, validateRequest, type RequestSchemas } from "../../../lib/validateRequest";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { PermanentDeleteRefused } from "./permanent-deleteHelpers";
import { permanentDeleteStep } from "./permanentDeleteStep";
import { permanentDeleteStep2 } from "./permanentDeleteStep2";
export {
  ACCOUNT_HAS_HISTORY_MESSAGE,
  CUSTOMER_HAS_HISTORY_MESSAGE,
  CUSTOMER_HAS_OPENING_MESSAGE,
  EMPLOYEE_HAS_HISTORY_MESSAGE,
  LOCATION_HAS_STOCK_MESSAGE,
  ORPHANED_POS_POSTED_MESSAGE,
  RETIRED_VOUCHER_NOT_DELETABLE_MESSAGE,
} from "./permanent-deleteHelpers";

export type DeletedItemRow = { id: AnyPgColumn; companyId: AnyPgColumn | null; deletedAt: AnyPgColumn };

/** Shared with the dependent-record registration of the same path. */
export const permanentDeleteInput = {
  // permanentDeleteStep parses the id itself (parseInt + isNaN).
  params: z.strictObject({ type: stringParam, id: stringParam }),
  query: emptyQuery,
  body: emptyBody,
} satisfies RequestSchemas;

export function registerDeletedItemsPermanentDeleteRoutes(app: Express) {
  // Permanently delete an item
  app.delete(
    "/api/deleted-items/:type/:id/permanent",
    requireAuth,
    requireNonPOS,
    validateRequest(permanentDeleteInput),
    async (req, res) => {
      try {
        const pd1 = await permanentDeleteStep({ req, res });
        if (pd1.done) return pd1.value;
        const { type } = pd1;
        const pd2 = await permanentDeleteStep2({ pd1, req, res });
        if (pd2.done) return pd2.value;

        res.json({ message: `${type} permanently deleted` });
      } catch (error: unknown) {
        if (error instanceof PermanentDeleteRefused) return res.status(409).json({ message: error.message });
        res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
      }
    }
  );

  // ============ AI Chatbot API Endpoints ============

  // Check if chatbot is enabled for current user
}
