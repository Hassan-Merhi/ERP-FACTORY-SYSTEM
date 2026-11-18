// Extracted from ./intercompanyNotificationRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { db } from "../db";
import {
  pairLines,
  postErpVoucherTx,
  sessionPostingActor,
  withAuthorizedPostingCompany,
} from "../services/accounting/erpVoucherPosting";
import { requireAuth } from "../auth";
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
import { and, desc, eq, inArray } from "drizzle-orm";

export function registerIntercompanyNotificationRoutesPart2(app: Express) {
  // ── GET /api/intercompany-requests ──────────────────────────────────────────
  // Returns requests for the current user (optionally filter by status)
  app.get("/api/intercompany-requests", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) return res.json([]);

      const statusFilter = req.query.status as string | undefined;

      // Get links this user is a recipient of, then intersect with links whose
      // destCompanyId the user actually belongs to (defense-in-depth against stale recipients)
      const recipientLinks = await db
        .select({ linkId: intercompanyLinkRecipients.linkId })
        .from(intercompanyLinkRecipients)
        .where(eq(intercompanyLinkRecipients.userId, userId));

      if (recipientLinks.length === 0) return res.json([]);
      const candidateLinkIds = recipientLinks.map((r) => r.linkId);

      // Load links and filter to those where user has a destCompany role
      const candidateLinks = await db
        .select({ id: intercompanyAccountLinks.id, destCompanyId: intercompanyAccountLinks.destCompanyId })
        .from(intercompanyAccountLinks)
        .where(inArray(intercompanyAccountLinks.id, candidateLinkIds));

      const userCompanies = await db
        .select({ companyId: userCompanyRoles.companyId })
        .from(userCompanyRoles)
        .where(eq(userCompanyRoles.userId, userId));
      const userCompanySet = new Set(userCompanies.map((r) => r.companyId));

      const linkIds = candidateLinks.filter((l) => userCompanySet.has(l.destCompanyId)).map((l) => l.id);

      if (linkIds.length === 0) return res.json([]);

      const requestRows = await db
        .select()
        .from(intercompanyPaymentRequests)
        .where(
          and(
            inArray(intercompanyPaymentRequests.linkId, linkIds),
            ...(statusFilter ? [eq(intercompanyPaymentRequests.status, statusFilter)] : [])
          )
        )
        .orderBy(desc(intercompanyPaymentRequests.createdAt));

      // Enrich with company names, link info
      const allLinks = await db.select().from(intercompanyAccountLinks);
      const allCompanies = await db.select({ id: companies.id, name: companies.name }).from(companies);
      const allAccounts = await db
        .select({ id: ledgerAccounts.id, name: ledgerAccounts.name, companyId: ledgerAccounts.companyId })
        .from(ledgerAccounts);
      const allUsers = await db.select({ id: users.id, username: users.username }).from(users);

      const linkMap = new Map(allLinks.map((l) => [l.id, l]));
      const companyMap = new Map(allCompanies.map((c) => [c.id, c.name]));
      const accountMap = new Map(allAccounts.map((a) => [a.id, { name: a.name, companyId: a.companyId }]));
      const userMap = new Map(allUsers.map((u) => [u.id, u.username]));

      const enriched = requestRows.map((r) => {
        const link = linkMap.get(r.linkId);
        return {
          ...r,
          fromCompanyName: companyMap.get(r.fromCompanyId) ?? "Unknown",
          destCompanyName: link ? (companyMap.get(link.destCompanyId) ?? "Unknown") : "Unknown",
          destCompanyId: link?.destCompanyId,
          linkDestLedgerAccountId: link?.destLedgerAccountId,
          linkDestLedgerName: link ? (accountMap.get(link.destLedgerAccountId)?.name ?? "Unknown") : "Unknown",
          approvedByUsername: r.approvedByUserId ? (userMap.get(r.approvedByUserId) ?? r.approvedByUserId) : null,
          chosenAccountName: r.destLedgerAccountId ? (accountMap.get(r.destLedgerAccountId)?.name ?? null) : null,
        };
      });

      res.json(enriched);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── GET /api/vouchers/:id/intercompany-status ───────────────────────────────
  app.get("/api/vouchers/:id/intercompany-status", requireAuth, async (req, res) => {
    try {
      const voucherId = parseInt(req.params.id);
      if (isNaN(voucherId)) return res.json([]);

      // Verify the voucher belongs to a company the requester has access to
      const [voucherRow] = await db
        .select({ companyId: vouchers.companyId })
        .from(vouchers)
        .where(eq(vouchers.id, voucherId));
      if (!voucherRow) return res.json([]);

      const userId = req.session.userId!;
      const [hasAccess] = await db
        .select({ id: userCompanyRoles.id })
        .from(userCompanyRoles)
        .where(and(eq(userCompanyRoles.userId, userId), eq(userCompanyRoles.companyId, voucherRow.companyId)));
      if (!hasAccess) return res.status(403).json({ message: "Access denied" });

      const requests = await db
        .select()
        .from(intercompanyPaymentRequests)
        .where(eq(intercompanyPaymentRequests.fromVoucherId, voucherId));

      if (requests.length === 0) return res.json([]);

      const allLinks = await db.select().from(intercompanyAccountLinks);
      const allCompanies = await db.select({ id: companies.id, name: companies.name }).from(companies);
      const allUsers = await db.select({ id: users.id, username: users.username }).from(users);

      const linkMap = new Map(allLinks.map((l) => [l.id, l]));
      const companyMap = new Map(allCompanies.map((c) => [c.id, c.name]));
      const userMap = new Map(allUsers.map((u) => [u.id, u.username]));

      const enriched = requests.map((r) => {
        const link = linkMap.get(r.linkId);
        return {
          ...r,
          destCompanyName: link ? (companyMap.get(link.destCompanyId) ?? "Unknown") : "Unknown",
          approvedByUsername: r.approvedByUserId ? (userMap.get(r.approvedByUserId) ?? r.approvedByUserId) : null,
        };
      });

      res.json(enriched);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── POST /api/intercompany-requests/:id/approve ─────────────────────────────
  app.post("/api/intercompany-requests/:id/approve", requireAuth, async (req, res) => {
    try {
      const requestId = parseInt(req.params.id);
      if (isNaN(requestId)) return res.status(400).json({ message: "Invalid ID" });

      const userId = req.session.userId!;
      const { destLedgerAccountId, description: customDescription } = req.body;
      if (!destLedgerAccountId) return res.status(400).json({ message: "Please select an account" });

      // Pre-flight: load request, recipient membership, link, and account ownership
      // (all outside the transaction so we can return clean 403/404 before locking)
      const [request] = await db
        .select()
        .from(intercompanyPaymentRequests)
        .where(eq(intercompanyPaymentRequests.id, requestId));
      if (!request) return res.status(404).json({ message: "Request not found" });
      if (request.status !== "pending")
        return res.status(400).json({ message: "Request is already " + request.status });

      // Verify this user is a recipient of the link
      const [recipient] = await db
        .select()
        .from(intercompanyLinkRecipients)
        .where(
          and(eq(intercompanyLinkRecipients.linkId, request.linkId), eq(intercompanyLinkRecipients.userId, userId))
        );
      if (!recipient) return res.status(403).json({ message: "You are not authorised to approve this request" });

      const [link] = await db
        .select()
        .from(intercompanyAccountLinks)
        .where(eq(intercompanyAccountLinks.id, request.linkId));
      if (!link) return res.status(404).json({ message: "Link not found" });

      // Verify the approver has a role in the destination company
      const [destMembership] = await db
        .select({ id: userCompanyRoles.id })
        .from(userCompanyRoles)
        .where(and(eq(userCompanyRoles.userId, userId), eq(userCompanyRoles.companyId, link.destCompanyId)));
      if (!destMembership) {
        return res.status(403).json({ message: "You do not have a role in the destination company" });
      }

      // ── Validate that the chosen debit account belongs to the destination company ──
      const [chosenAccount] = await db
        .select({ id: ledgerAccounts.id, name: ledgerAccounts.name, companyId: ledgerAccounts.companyId })
        .from(ledgerAccounts)
        .where(eq(ledgerAccounts.id, destLedgerAccountId));
      if (!chosenAccount) return res.status(400).json({ message: "Selected account not found" });
      if (chosenAccount.companyId !== link.destCompanyId) {
        return res.status(400).json({ message: "Selected account does not belong to the destination company" });
      }

      // Resolve the CR (IC) account name for the auto-description
      const [crAccount] = await db
        .select({ name: ledgerAccounts.name })
        .from(ledgerAccounts)
        .where(eq(ledgerAccounts.id, link.destLedgerAccountId));

      // Use provided description or fall back to "Received from [CR] into [DR]"
      const resolvedDescription =
        customDescription && customDescription.trim()
          ? customDescription.trim()
          : `Received from ${crAccount?.name ?? "IC account"} into ${chosenAccount.name}`;

      const destCompanyId = link.destCompanyId;
      const approvedAt = new Date();

      // ── Atomic transaction: conditional status claim + voucher creation ──────────
      // The UPDATE WHERE status='pending' is the single concurrency gate.
      // If zero rows update (already approved by another recipient), we abort.
      // Phase 22 (B): the receipt posts into the destination company through the
      // central engine (membership in it was checked above).
      const result = await withAuthorizedPostingCompany(destCompanyId, () =>
        db.transaction(async (tx) => {
          // Claim the request atomically — only succeeds once
          const claimed = await tx
            .update(intercompanyPaymentRequests)
            .set({
              status: "approved",
              destLedgerAccountId,
              approvedByUserId: userId,
              approvedAt,
            })
            .where(
              and(eq(intercompanyPaymentRequests.id, requestId), eq(intercompanyPaymentRequests.status, "pending"))
            )
            .returning({ id: intercompanyPaymentRequests.id });

          if (claimed.length === 0) {
            throw new Error("ALREADY_PROCESSED");
          }

          // Create Receipt voucher in dest company
          // DR: chosen account (cash/bank received)
          // CR: link.destLedgerAccountId (the intercompany account in dest)
          const { voucher: createdVoucher } = await postErpVoucherTx(tx, {
            companyId: destCompanyId,
            voucherType: "Receipt",
            voucherDate: request.fromVoucherDate,
            description: resolvedDescription,
            lines: pairLines(
              { ledgerAccountId: destLedgerAccountId },
              { ledgerAccountId: link.destLedgerAccountId },
              request.amount,
              resolvedDescription
            ),
            source: { type: "intercompany-payment-request", id: requestId },
            actor: sessionPostingActor(req, "Intercompany payment request approval"),
          });

          // Store the mirror voucher ID back on the request
          await tx
            .update(intercompanyPaymentRequests)
            .set({ destVoucherId: createdVoucher.id })
            .where(eq(intercompanyPaymentRequests.id, requestId));

          return { voucherId: createdVoucher.id, voucherNumber: createdVoucher.voucherNumber };
        })
      );

      res.json({ success: true, voucherId: result.voucherId, voucherNumber: result.voucherNumber });
    } catch (err: unknown) {
      if (getErrorMessage(err) === "ALREADY_PROCESSED") {
        return res.status(409).json({ message: "This request has already been processed by another user." });
      }
      logger.error("[IC approve]", { error: err });
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── POST /api/intercompany-requests/:id/dismiss ─────────────────────────────
  app.post("/api/intercompany-requests/:id/dismiss", requireAuth, async (req, res) => {
    try {
      const requestId = parseInt(req.params.id);
      if (isNaN(requestId)) return res.status(400).json({ message: "Invalid ID" });

      const userId = req.session.userId!;
      const { note } = req.body;

      const [request] = await db
        .select()
        .from(intercompanyPaymentRequests)
        .where(eq(intercompanyPaymentRequests.id, requestId));
      if (!request) return res.status(404).json({ message: "Request not found" });
      if (request.status !== "pending")
        return res.status(400).json({ message: "Request is already " + request.status });

      const [recipient] = await db
        .select()
        .from(intercompanyLinkRecipients)
        .where(
          and(eq(intercompanyLinkRecipients.linkId, request.linkId), eq(intercompanyLinkRecipients.userId, userId))
        );
      if (!recipient) return res.status(403).json({ message: "You are not authorised to dismiss this request" });

      // Verify the dismisser has a role in the destination company
      const [dimLink] = await db
        .select({ destCompanyId: intercompanyAccountLinks.destCompanyId })
        .from(intercompanyAccountLinks)
        .where(eq(intercompanyAccountLinks.id, request.linkId));
      if (dimLink) {
        const [dimMembership] = await db
          .select({ id: userCompanyRoles.id })
          .from(userCompanyRoles)
          .where(and(eq(userCompanyRoles.userId, userId), eq(userCompanyRoles.companyId, dimLink.destCompanyId)));
        if (!dimMembership) {
          return res.status(403).json({ message: "You do not have a role in the destination company" });
        }
      }

      // Atomic conditional claim — same pattern as approve to prevent TOCTOU race
      const claimed = await db
        .update(intercompanyPaymentRequests)
        .set({
          status: "dismissed",
          approvedByUserId: userId,
          approvedAt: new Date(),
          dismissNote: note || null,
        })
        .where(and(eq(intercompanyPaymentRequests.id, requestId), eq(intercompanyPaymentRequests.status, "pending")))
        .returning({ id: intercompanyPaymentRequests.id });

      if (claimed.length === 0) {
        return res.status(409).json({ message: "This request has already been processed by another user." });
      }

      res.json({ success: true });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}
