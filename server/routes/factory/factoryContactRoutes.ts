import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { factoryContacts } from "@shared/schema";
import { eq, and, asc } from "drizzle-orm";
import { z } from "zod";
import {
  emptyBody,
  emptyQuery,
  stringIdParams,
  validateRequest,
  validatedInput,
  type RequestSchemas,
} from "../../lib/validateRequest";

function getCompanyId(req: Request): number | null {
  const s = req.session;
  return s?.factoryCompanyId || s?.currentCompanyId || null;
}

const contactBodySchema = z.strictObject({
  name: z.string().min(1),
  role: z.string().optional().nullable(),
  numbers: z.array(z.strictObject({ label: z.string(), number: z.string() })).default([]),
  notes: z.string().optional().nullable(),
});

// The id is parsed with parseInt below, as before, so any non-empty segment is accepted here.
const createContactInput = { query: emptyQuery, body: contactBodySchema } satisfies RequestSchemas;
const updateContactInput = {
  params: stringIdParams,
  query: emptyQuery,
  body: contactBodySchema,
} satisfies RequestSchemas;
const deleteContactInput = { params: stringIdParams, query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

export function registerFactoryContactRoutes(app: Express) {
  // LIST
  app.get("/api/factory/contacts", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const rows = await db
        .select()
        .from(factoryContacts)
        .where(eq(factoryContacts.companyId, companyId))
        .orderBy(asc(factoryContacts.name));

      res.json(rows);
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // CREATE
  app.post(
    "/api/factory/contacts",
    requireAuth,
    validateRequest(createContactInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const { body } = validatedInput(req, createContactInput);

        const [row] = await db
          .insert(factoryContacts)
          .values({ companyId, ...body })
          .returning();

        res.json(row);
      } catch (e: unknown) {
        res.status(500).json({ message: getErrorMessage(e) });
      }
    }
  );

  // UPDATE
  app.patch(
    "/api/factory/contacts/:id",
    requireAuth,
    validateRequest(updateContactInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const { params, body } = validatedInput(req, updateContactInput);

        const id = parseInt(params.id);
        if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });

        const [row] = await db
          .update(factoryContacts)
          .set({ ...body, updatedAt: new Date() })
          .where(and(eq(factoryContacts.id, id), eq(factoryContacts.companyId, companyId)))
          .returning();

        if (!row) return res.status(404).json({ message: "Contact not found" });
        res.json(row);
      } catch (e: unknown) {
        res.status(500).json({ message: getErrorMessage(e) });
      }
    }
  );

  // DELETE
  app.delete(
    "/api/factory/contacts/:id",
    requireAuth,
    validateRequest(deleteContactInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const id = parseInt(validatedInput(req, deleteContactInput).params.id);
        if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });

        await db
          .delete(factoryContacts)
          .where(and(eq(factoryContacts.id, id), eq(factoryContacts.companyId, companyId)));

        res.json({ ok: true });
      } catch (e: unknown) {
        res.status(500).json({ message: getErrorMessage(e) });
      }
    }
  );
}
