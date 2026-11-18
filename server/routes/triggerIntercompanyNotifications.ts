// Extracted from ./intercompanyNotificationRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { db } from "../db";
import { requireAuth, requireRole } from "../auth";
import { dispatchNotification } from "../lib/notificationService";
import {
  companies,
  intercompanyAccountLinks,
  intercompanyLinkRecipients,
  intercompanyPaymentRequests,
  ledgerAccounts,
  userCompanyRoles,
  users,
  vouchers,
} from "@shared/schema";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";

// ── Helper: fire-and-forget intercompany notification trigger ────────────────
// Call after a voucher is successfully saved. Checks if any ledger entry in
// the new voucher matches a source account in intercompany_account_links.
// Never throws — errors are logged and swallowed so the voucher save succeeds.
export async function triggerIntercompanyNotifications(
  companyId: number,
  voucherId: number,
  voucherNumber: string,
  voucherDate: string,
  amount: string,
  description: string | null,
  entryLedgerAccountIds: (number | null)[],
  voucherType?: string
) {
  try {
    // Only trigger for Payment and Receipt vouchers — other types (Journal, Sales, etc.)
    // touch intercompany ledgers in ways that don't represent a cross-company payment
    if (voucherType && voucherType !== "Payment" && voucherType !== "Receipt") return;

    const ledgerIds = entryLedgerAccountIds.filter((id): id is number => id !== null && id !== undefined);
    if (ledgerIds.length === 0) return;

    // Find any intercompany links where source matches this company + one of the ledger accounts
    const links = await db
      .select()
      .from(intercompanyAccountLinks)
      .where(
        and(
          eq(intercompanyAccountLinks.sourceCompanyId, companyId),
          eq(intercompanyAccountLinks.active, true),
          inArray(intercompanyAccountLinks.sourceLedgerAccountId, ledgerIds)
        )
      );

    if (links.length === 0) return;

    for (const link of links) {
      // Insert one pending request per matching link
      const [inserted] = await db
        .insert(intercompanyPaymentRequests)
        .values({
          linkId: link.id,
          fromCompanyId: companyId,
          fromVoucherId: voucherId,
          fromVoucherNumber: voucherNumber,
          fromVoucherDate: voucherDate,
          amount,
          description: description || null,
          status: "pending",
        })
        .returning({ id: intercompanyPaymentRequests.id });

      // Dispatch INTERCOMPANY_REQUEST notification via the unified notification system
      dispatchNotification({
        eventType: "INTERCOMPANY_REQUEST",
        title: "Intercompany Payment Request",
        message: `Payment request from voucher ${voucherNumber} — ${description || ""}`.trim().replace(/—\s*$/, ""),
        entityType: "intercompany_payment_request",
        entityId: inserted?.id,
        companyId,
      }).catch(() => {});
    }
  } catch (err: unknown) {
    logger.error("[IntercompanyNotif] trigger failed (non-fatal):", { error: getErrorMessage(err) });
  }
}

export function registerIntercompanyNotificationRoutesPart1(app: Express) {
  // ── GET /api/intercompany-links ─────────────────────────────────────────────
  app.get("/api/intercompany-links", requireAuth, requireRole("Admin", "Developer"), async (req, res) => {
    try {
      const links = await db
        .select({
          id: intercompanyAccountLinks.id,
          label: intercompanyAccountLinks.label,
          sourceCompanyId: intercompanyAccountLinks.sourceCompanyId,
          destCompanyId: intercompanyAccountLinks.destCompanyId,
          sourceLedgerAccountId: intercompanyAccountLinks.sourceLedgerAccountId,
          destLedgerAccountId: intercompanyAccountLinks.destLedgerAccountId,
          active: intercompanyAccountLinks.active,
          createdAt: intercompanyAccountLinks.createdAt,
          sourceCompanyName: companies.name,
          sourceLedgerName: ledgerAccounts.name,
        })
        .from(intercompanyAccountLinks)
        .leftJoin(companies, eq(companies.id, intercompanyAccountLinks.sourceCompanyId))
        .leftJoin(ledgerAccounts, eq(ledgerAccounts.id, intercompanyAccountLinks.sourceLedgerAccountId))
        .orderBy(desc(intercompanyAccountLinks.createdAt));

      // Enrich with dest company and dest ledger names
      const allCompanies = await db.select({ id: companies.id, name: companies.name }).from(companies);
      const allAccounts = await db
        .select({ id: ledgerAccounts.id, name: ledgerAccounts.name, companyId: ledgerAccounts.companyId })
        .from(ledgerAccounts);
      const companyMap = new Map(allCompanies.map((c) => [c.id, c.name]));
      const accountMap = new Map(allAccounts.map((a) => [a.id, a.name]));

      const enriched = links.map((l) => ({
        ...l,
        destCompanyName: companyMap.get(l.destCompanyId) ?? "Unknown",
        destLedgerName: accountMap.get(l.destLedgerAccountId) ?? "Unknown",
      }));

      res.json(enriched);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── GET /api/intercompany-links/:id/recipients ──────────────────────────────
  app.get(
    "/api/intercompany-links/:id/recipients",
    requireAuth,
    requireRole("Admin", "Developer"),
    async (req, res) => {
      try {
        const linkId = parseInt(req.params.id);
        if (isNaN(linkId)) return res.status(400).json({ message: "Invalid ID" });

        const rows = await db
          .select({
            id: intercompanyLinkRecipients.id,
            userId: intercompanyLinkRecipients.userId,
            username: users.username,
          })
          .from(intercompanyLinkRecipients)
          .leftJoin(users, eq(users.id, intercompanyLinkRecipients.userId))
          .where(eq(intercompanyLinkRecipients.linkId, linkId));

        res.json(rows);
      } catch (err: unknown) {
        res.status(500).json({ message: getErrorMessage(err) });
      }
    }
  );

  // ── GET /api/companies/:id/member-ids ─────────────────────────────────────
  // Returns IDs of users that have any role in the given company (Admin/Dev only)
  app.get("/api/companies/:id/member-ids", requireAuth, requireRole("Admin", "Developer"), async (req, res) => {
    try {
      const companyId = parseInt(req.params.id);
      if (isNaN(companyId)) return res.status(400).json({ message: "Invalid company ID" });
      const rows = await db
        .select({ userId: userCompanyRoles.userId })
        .from(userCompanyRoles)
        .where(and(eq(userCompanyRoles.companyId, companyId), ne(userCompanyRoles.role, "Developer")));
      res.json(rows.map((r) => r.userId));
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── POST /api/intercompany-links ────────────────────────────────────────────
  app.post("/api/intercompany-links", requireAuth, requireRole("Admin", "Developer"), async (req, res) => {
    try {
      const {
        label,
        sourceCompanyId,
        sourceLedgerAccountId,
        destCompanyId,
        destLedgerAccountId,
        recipientUserIds = [],
      } = req.body;
      if (!sourceCompanyId || !sourceLedgerAccountId || !destCompanyId || !destLedgerAccountId) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      // Validate recipients belong to the destination company
      if (Array.isArray(recipientUserIds) && recipientUserIds.length > 0) {
        const destMembers = await db
          .select({ userId: userCompanyRoles.userId })
          .from(userCompanyRoles)
          .where(
            and(eq(userCompanyRoles.companyId, destCompanyId), inArray(userCompanyRoles.userId, recipientUserIds))
          );
        const validIds = new Set(destMembers.map((r) => r.userId));
        const invalid = (recipientUserIds as string[]).filter((uid) => !validIds.has(uid));
        if (invalid.length > 0) {
          return res
            .status(400)
            .json({ message: "Some selected recipients do not have a role in the destination company" });
        }
      }

      const [link] = await db
        .insert(intercompanyAccountLinks)
        .values({
          label: label || null,
          sourceCompanyId,
          sourceLedgerAccountId,
          destCompanyId,
          destLedgerAccountId,
          active: true,
        })
        .returning();

      if (Array.isArray(recipientUserIds) && recipientUserIds.length > 0) {
        await db
          .insert(intercompanyLinkRecipients)
          .values(recipientUserIds.map((uid: string) => ({ linkId: link.id, userId: uid })));
      }

      res.json(link);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── PUT /api/intercompany-links/:id ─────────────────────────────────────────
  app.put("/api/intercompany-links/:id", requireAuth, requireRole("Admin", "Developer"), async (req, res) => {
    try {
      const linkId = parseInt(req.params.id);
      if (isNaN(linkId)) return res.status(400).json({ message: "Invalid ID" });

      const {
        label,
        sourceCompanyId,
        sourceLedgerAccountId,
        destCompanyId,
        destLedgerAccountId,
        active,
        recipientUserIds,
      } = req.body;

      const linkFields = {
        ...(label !== undefined ? { label } : {}),
        ...(sourceCompanyId !== undefined ? { sourceCompanyId } : {}),
        ...(sourceLedgerAccountId !== undefined ? { sourceLedgerAccountId } : {}),
        ...(destCompanyId !== undefined ? { destCompanyId } : {}),
        ...(destLedgerAccountId !== undefined ? { destLedgerAccountId } : {}),
        ...(active !== undefined ? { active } : {}),
      };

      let updated: typeof intercompanyAccountLinks.$inferSelect | undefined;
      if (Object.keys(linkFields).length > 0) {
        const [row] = await db
          .update(intercompanyAccountLinks)
          .set(linkFields)
          .where(eq(intercompanyAccountLinks.id, linkId))
          .returning();
        updated = row;
        if (!updated) return res.status(404).json({ message: "Link not found" });
      } else {
        // Only recipients are being updated — fetch the link for validation below
        const [row] = await db
          .select()
          .from(intercompanyAccountLinks)
          .where(eq(intercompanyAccountLinks.id, linkId))
          .limit(1);
        updated = row;
        if (!updated) return res.status(404).json({ message: "Link not found" });
      }

      if (Array.isArray(recipientUserIds)) {
        // Validate recipients belong to the destination company
        const effectiveDestCompanyId = destCompanyId ?? updated.destCompanyId;
        if (recipientUserIds.length > 0) {
          const destMembers = await db
            .select({ userId: userCompanyRoles.userId })
            .from(userCompanyRoles)
            .where(
              and(
                eq(userCompanyRoles.companyId, effectiveDestCompanyId),
                inArray(userCompanyRoles.userId, recipientUserIds)
              )
            );
          const validIds = new Set(destMembers.map((r) => r.userId));
          const invalid = (recipientUserIds as string[]).filter((uid) => !validIds.has(uid));
          if (invalid.length > 0) {
            return res
              .status(400)
              .json({ message: "Some selected recipients do not have a role in the destination company" });
          }
        }
        await db.delete(intercompanyLinkRecipients).where(eq(intercompanyLinkRecipients.linkId, linkId));
        if (recipientUserIds.length > 0) {
          await db
            .insert(intercompanyLinkRecipients)
            .values(recipientUserIds.map((uid: string) => ({ linkId, userId: uid })));
        }
      }

      res.json(updated);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── DELETE /api/intercompany-links/:id ──────────────────────────────────────
  app.delete("/api/intercompany-links/:id", requireAuth, requireRole("Admin", "Developer"), async (req, res) => {
    try {
      const linkId = parseInt(req.params.id);
      if (isNaN(linkId)) return res.status(400).json({ message: "Invalid ID" });
      await db.delete(intercompanyAccountLinks).where(eq(intercompanyAccountLinks.id, linkId));
      res.json({ success: true });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── GET /api/intercompany-requests/pending-count ────────────────────────────
  // Returns number of pending requests addressed to the logged-in user
  app.get("/api/intercompany-requests/pending-count", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) return res.json({ count: 0 });

      // Find link IDs this user is a recipient of
      const recipientLinks = await db
        .select({ linkId: intercompanyLinkRecipients.linkId })
        .from(intercompanyLinkRecipients)
        .where(eq(intercompanyLinkRecipients.userId, userId));

      if (recipientLinks.length === 0) return res.json({ count: 0 });

      const linkIds = recipientLinks.map((r) => r.linkId);
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(intercompanyPaymentRequests)
        .innerJoin(vouchers, eq(vouchers.id, intercompanyPaymentRequests.fromVoucherId))
        .where(
          and(
            eq(intercompanyPaymentRequests.status, "pending"),
            inArray(intercompanyPaymentRequests.linkId, linkIds),
            isNull(vouchers.deletedAt)
          )
        );

      res.set("Cache-Control", "private, max-age=30");
      res.json({ count: row?.count ?? 0 });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}
