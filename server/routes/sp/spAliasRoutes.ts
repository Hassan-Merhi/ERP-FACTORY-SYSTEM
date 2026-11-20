import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { sql } from "drizzle-orm";
import { stockItemCodeAliases } from "@shared/schema";
import { requireSpCompany } from "./spHelpers";
import { resultRows } from "../../lib/queryResult";
import { z } from "zod";
import { stringIdParams, validateRequest, validatedInput, type RequestSchemas } from "../../lib/validateRequest";
import { numberish, spWriteFields } from "./spRequestSchemas";

const createAliasInput = {
  body: z.strictObject({
    ...spWriteFields,
    aliasCode: z.union([z.string(), z.number()]).optional(),
    stockItemId: numberish.optional(),
    description: z.string().nullable().optional(),
  }),
} satisfies RequestSchemas;

const deleteAliasInput = { params: stringIdParams } satisfies RequestSchemas;

// ── Aliases (article code → stock item mapping) ───────────────────────────

export function registerSpAliasRoutes(app: Express) {
  app.get("/api/sp/aliases", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;
      const rows = await db.execute(sql`
        SELECT a.id, a.alias_code, a.description, a.stock_item_id,
               si.name AS stock_item_name, si.code AS stock_item_code
        FROM stock_item_code_aliases a
        LEFT JOIN stock_items si ON a.stock_item_id = si.id
        WHERE a.company_id = ${companyId}
        ORDER BY a.alias_code ASC
      `);
      res.json(resultRows(rows));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/sp/aliases", requireAuth, validateRequest(createAliasInput), async (req: Request, res: Response) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;
      const { aliasCode, stockItemId, description } = req.body;
      if (!aliasCode || !stockItemId) return res.status(400).json({ message: "aliasCode and stockItemId required" });
      const [row] = await db
        .insert(stockItemCodeAliases)
        .values({
          companyId,
          stockItemId: parseInt(String(stockItemId)),
          aliasCode: String(aliasCode).trim(),
          description: description || null,
        })
        .returning();
      res.json(row);
    } catch (error: unknown) {
      if ((error as { code?: string }).code === "23505")
        return res.status(400).json({ message: "Alias code already exists for this company" });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.delete(
    "/api/sp/aliases/:id",
    requireAuth,
    validateRequest(deleteAliasInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = await requireSpCompany(req, res);
        if (!companyId) return;
        await db.execute(
          sql`DELETE FROM stock_item_code_aliases WHERE id = ${parseInt(validatedInput(req, deleteAliasInput).params.id)} AND company_id = ${companyId}`
        );
        res.json({ ok: true });
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
