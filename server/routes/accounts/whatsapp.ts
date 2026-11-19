/**
 * accountRoutes: AccountWhatsapp endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { factoryAccountWhatsappRules, ledgerAccounts } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { parseId } from "../../lib/parseId";
import { logger } from "../../lib/logger";
import { z } from "zod";
import { emptyQuery, stringParam, validateRequest, type RequestSchemas } from "../../lib/validateRequest";

// The accounts screen saves the rule it loaded (the full row, or the
// defaults with id: null) after editing it, so the row's own fields come back.
const whatsappRuleInput = {
  params: z.strictObject({ accountId: stringParam }),
  query: emptyQuery,
  body: z.strictObject({
    enabled: z.boolean().nullable().optional(),
    whatsappChatId: z.string().nullable().optional(),
    sendOnPayment: z.boolean().nullable().optional(),
    sendOnReceipt: z.boolean().nullable().optional(),
    sendOnJournal: z.boolean().nullable().optional(),
    id: z.unknown().optional(), // sent by client/src/pages/accountslegacy/useAccountsLegacyModel.ts; not used
    companyId: z.unknown().optional(), // sent by client/src/pages/accountslegacy/useAccountsLegacyModel.ts; not used
    ledgerAccountId: z.unknown().optional(), // sent by client/src/pages/accountslegacy/useAccountsLegacyModel.ts; not used
    createdAt: z.unknown().optional(), // sent by client/src/pages/accountslegacy/useAccountsLegacyModel.ts; not used
    updatedAt: z.unknown().optional(), // sent by client/src/pages/accountslegacy/useAccountsLegacyModel.ts; not used
  }),
} satisfies RequestSchemas;

export function registerAccountWhatsappRoutes(app: Express) {
  // ERP-mode WhatsApp rule GET — mirrors /api/factory/accounts/:id/whatsapp-rule
  // without the factory-company middleware guard.
  app.get("/api/accounts/:accountId/whatsapp-rule", requireAuth, async (req: Request, res: Response) => {
    try {
      const accountId = parseId(req.params.accountId);
      if (accountId === null) return res.status(400).json({ message: "Invalid id" });
      const companyId = req.session?.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const [rule] = await db
        .select()
        .from(factoryAccountWhatsappRules)
        .where(
          and(
            eq(factoryAccountWhatsappRules.companyId, companyId),
            eq(factoryAccountWhatsappRules.ledgerAccountId, accountId)
          )
        );

      res.json(
        rule ?? {
          id: null,
          companyId,
          ledgerAccountId: accountId,
          enabled: false,
          whatsappChatId: null,
          sendOnPayment: true,
          sendOnReceipt: true,
          sendOnJournal: true,
        }
      );
    } catch (err: unknown) {
      logger.error("[erp-wa] GET rule error", { error: err });
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ERP-mode WhatsApp rule PUT (upsert) — mirrors /api/factory/accounts/:id/whatsapp-rule.
  app.put(
    "/api/accounts/:accountId/whatsapp-rule",
    requireAuth,
    validateRequest(whatsappRuleInput),
    async (req: Request, res: Response) => {
      try {
        const accountId = parseId(req.params.accountId);
        if (accountId === null) return res.status(400).json({ message: "Invalid id" });
        const companyId = req.session?.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const [acct] = await db
          .select({ id: ledgerAccounts.id })
          .from(ledgerAccounts)
          .where(and(eq(ledgerAccounts.id, accountId), eq(ledgerAccounts.companyId, companyId)));
        if (!acct) return res.status(404).json({ message: "Account not found" });

        const { enabled, whatsappChatId, sendOnPayment, sendOnReceipt, sendOnJournal } = req.body;

        const [upserted] = await db
          .insert(factoryAccountWhatsappRules)
          .values({
            companyId,
            ledgerAccountId: accountId,
            enabled: Boolean(enabled),
            whatsappChatId: whatsappChatId ?? null,
            sendOnPayment: sendOnPayment ?? true,
            sendOnReceipt: sendOnReceipt ?? true,
            sendOnJournal: sendOnJournal ?? true,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [factoryAccountWhatsappRules.companyId, factoryAccountWhatsappRules.ledgerAccountId],
            set: {
              enabled: Boolean(enabled),
              whatsappChatId: whatsappChatId ?? null,
              sendOnPayment: sendOnPayment ?? true,
              sendOnReceipt: sendOnReceipt ?? true,
              sendOnJournal: sendOnJournal ?? true,
              updatedAt: new Date(),
            },
          })
          .returning();

        res.json(upserted);
      } catch (err: unknown) {
        logger.error("[erp-wa] PUT rule error", { error: err });
        res.status(500).json({ message: getErrorMessage(err) });
      }
    }
  );

  // Get all vouchers with date filtering
}
