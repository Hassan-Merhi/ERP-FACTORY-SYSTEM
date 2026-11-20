/**
 * rentalUnitsContractsRoutes: RentalContractNote endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { RentalRoutesContext } from "./_helpers";
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { getCompanyId } from "../shared";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { eq, and } from "drizzle-orm";
import { propertyContracts } from "@shared/schema";
import { validateRequest, validatedInput } from "../../../lib/validateRequest";
import { contractNoteInput, contractStatementNoteInput } from "../rentalWriteRouteSchemas";

export function registerRentalContractNoteRoutes(app: Express, ctx: RentalRoutesContext) {
  const { module, urlPrefix } = ctx;
  // ── UPDATE CONTRACT NOTE ──
  app.patch(
    `${urlPrefix}/contracts/:id/note`,
    requireAuth,
    validateRequest(contractNoteInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const {
          params: { id },
          body: { notes },
        } = validatedInput(req, contractNoteInput);
        const [contract] = await db
          .select()
          .from(propertyContracts)
          .where(
            and(
              eq(propertyContracts.id, id),
              eq(propertyContracts.companyId, companyId),
              eq(propertyContracts.module, module)
            )
          );
        if (!contract) return res.status(404).json({ message: "Contract not found" });
        await db
          .update(propertyContracts)
          .set({ notes: notes || null })
          .where(eq(propertyContracts.id, id));
        res.json({ ok: true });
      } catch (e: unknown) {
        res.status(500).json({ message: getErrorMessage(e) });
      }
    }
  );

  // ── SAVE STATEMENT NOTE ──
  app.patch(
    `${urlPrefix}/contracts/:id/statement-note`,
    requireAuth,
    validateRequest(contractStatementNoteInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const {
          params: { id },
          body: { statementNote },
        } = validatedInput(req, contractStatementNoteInput);
        const [contract] = await db
          .select()
          .from(propertyContracts)
          .where(
            and(
              eq(propertyContracts.id, id),
              eq(propertyContracts.companyId, companyId),
              eq(propertyContracts.module, module)
            )
          );
        if (!contract) return res.status(404).json({ message: "Contract not found" });
        await db
          .update(propertyContracts)
          .set({ statementNote: statementNote || null })
          .where(eq(propertyContracts.id, id));
        res.json({ ok: true });
      } catch (e: unknown) {
        res.status(500).json({ message: getErrorMessage(e) });
      }
    }
  );
}
