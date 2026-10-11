import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { db } from "../db";
import { requireAuth } from "../auth";
import { approvalRequests } from "@shared/schema";
import { eq, and, desc } from "drizzle-orm";
import { logAudit } from "./_helpers";

export function registerApprovalRoutes(app: Express) {
  // ── List all requests for company (Admin / Developer / Owner only) ──────────
  app.get("/api/approvals", requireAuth, async (req, res) => {
    try {
      const role = req.session.currentRole ?? "";
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!["Admin", "Developer", "Owner"].includes(role)) {
        return res.status(403).json({ message: "Access denied" });
      }
      const { status } = req.query;
      let rows = await db
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.companyId, companyId))
        .orderBy(desc(approvalRequests.requestedAt))
        .limit(300);
      if (status && typeof status === "string") {
        rows = rows.filter((r) => r.status === status);
      }
      res.json(rows);
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── List my own requests (any authenticated user) ───────────────────────────
  app.get("/api/approvals/my", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const rows = await db
        .select()
        .from(approvalRequests)
        .where(and(eq(approvalRequests.companyId, companyId), eq(approvalRequests.requestedByUserId, userId)))
        .orderBy(desc(approvalRequests.requestedAt))
        .limit(100);
      res.json(rows);
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── Create a new approval request ──────────────────────────────────────────
  app.post("/api/approvals", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const userId = req.session.userId!;
      const username = req.session.username ?? "Unknown";
      const { actionType, targetTable, targetRecordId, targetIdentifier, payload, oldValue, newValue, amountValue } =
        req.body;
      if (!actionType) return res.status(400).json({ message: "actionType is required" });
      // Phase 21 (B): the write and its audit commit together.
      const row = await db.transaction(async (tx) => {
        const [written] = await tx
          .insert(approvalRequests)
          .values({
            companyId,
            requestedByUserId: userId,
            requestedByUsername: username,
            actionType,
            targetTable: targetTable ?? null,
            targetRecordId: targetRecordId ?? null,
            targetIdentifier: targetIdentifier ?? null,
            payload: payload ?? null,
            oldValue: oldValue ?? null,
            newValue: newValue ?? null,
            amountValue: amountValue ?? null,
            status: "pending",
          })
          .returning();
        await logAudit(
          {
            userId,
            username,
            companyId,
            action: "create",
            tableName: "approval_requests",
            recordId: written.id,
            recordIdentifier: actionType,
            changes: { status: { old: null, new: "pending" } },
          },
          tx
        );
        return written;
      });
      res.status(201).json(row);
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── Approve a pending request (Admin / Developer, not own request) ──────────
  app.post("/api/approvals/:id/approve", requireAuth, async (req, res) => {
    try {
      const role = req.session.currentRole ?? "";
      if (!["Admin", "Developer"].includes(role)) {
        return res.status(403).json({ message: "Only Admin or Developer can approve requests" });
      }
      const userId = req.session.userId!;
      const username = req.session.username ?? "Unknown";
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseInt(req.params.id);
      const [existing] = await db
        .select()
        .from(approvalRequests)
        .where(and(eq(approvalRequests.id, id), eq(approvalRequests.companyId, companyId)));
      if (!existing) return res.status(404).json({ message: "Request not found" });
      if (existing.status !== "pending") return res.status(400).json({ message: "Request is not pending" });
      if (existing.requestedByUserId === userId) {
        return res.status(403).json({ message: "You cannot approve your own request" });
      }
      const { reviewerNote } = req.body;
      // Phase 21 (B): the write and its audit commit together.
      const updated = await db.transaction(async (tx) => {
        const [written] = await tx
          .update(approvalRequests)
          .set({
            status: "approved",
            reviewedByUserId: userId,
            reviewedByUsername: username,
            reviewedAt: new Date(),
            reviewerNote: reviewerNote ?? null,
          })
          .where(eq(approvalRequests.id, id))
          .returning();
        await logAudit(
          {
            userId,
            username,
            companyId,
            action: "update",
            tableName: "approval_requests",
            recordId: id,
            recordIdentifier: `Approved: ${existing.actionType}`,
            changes: { status: { old: "pending", new: "approved" } },
          },
          tx
        );
        return written;
      });
      res.json(updated);
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── Reject a pending request (Admin / Developer, not own request) ───────────
  app.post("/api/approvals/:id/reject", requireAuth, async (req, res) => {
    try {
      const role = req.session.currentRole ?? "";
      if (!["Admin", "Developer"].includes(role)) {
        return res.status(403).json({ message: "Only Admin or Developer can reject requests" });
      }
      const userId = req.session.userId!;
      const username = req.session.username ?? "Unknown";
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseInt(req.params.id);
      const [existing] = await db
        .select()
        .from(approvalRequests)
        .where(and(eq(approvalRequests.id, id), eq(approvalRequests.companyId, companyId)));
      if (!existing) return res.status(404).json({ message: "Request not found" });
      if (existing.status !== "pending") return res.status(400).json({ message: "Request is not pending" });
      if (existing.requestedByUserId === userId) {
        return res.status(403).json({ message: "You cannot reject your own request" });
      }
      const { reviewerNote } = req.body;
      // Phase 21 (B): the write and its audit commit together.
      const updated = await db.transaction(async (tx) => {
        const [written] = await tx
          .update(approvalRequests)
          .set({
            status: "rejected",
            reviewedByUserId: userId,
            reviewedByUsername: username,
            reviewedAt: new Date(),
            reviewerNote: reviewerNote ?? null,
          })
          .where(eq(approvalRequests.id, id))
          .returning();
        await logAudit(
          {
            userId,
            username,
            companyId,
            action: "update",
            tableName: "approval_requests",
            recordId: id,
            recordIdentifier: `Rejected: ${existing.actionType}`,
            changes: { status: { old: "pending", new: "rejected" } },
          },
          tx
        );
        return written;
      });
      res.json(updated);
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── Mark an approved request as executed ────────────────────────────────────
  app.post("/api/approvals/:id/execute", requireAuth, async (req, res) => {
    try {
      const role = req.session.currentRole ?? "";
      if (!["Admin", "Developer"].includes(role)) {
        return res.status(403).json({ message: "Only Admin or Developer can mark requests as executed" });
      }
      const userId = req.session.userId!;
      const username = req.session.username ?? "Unknown";
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseInt(req.params.id);
      const [existing] = await db
        .select()
        .from(approvalRequests)
        .where(and(eq(approvalRequests.id, id), eq(approvalRequests.companyId, companyId)));
      if (!existing) return res.status(404).json({ message: "Request not found" });
      if (existing.status !== "approved") {
        return res.status(400).json({ message: "Request must be approved before it can be executed" });
      }
      // Phase 21 (B): the write and its audit commit together.
      const updated = await db.transaction(async (tx) => {
        const [written] = await tx
          .update(approvalRequests)
          .set({ status: "executed", executedAt: new Date() })
          .where(eq(approvalRequests.id, id))
          .returning();
        await logAudit(
          {
            userId,
            username,
            companyId,
            action: "update",
            tableName: "approval_requests",
            recordId: id,
            recordIdentifier: `Executed: ${existing.actionType}`,
            changes: { status: { old: "approved", new: "executed" } },
          },
          tx
        );
        return written;
      });
      res.json(updated);
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── Cancel own pending request ──────────────────────────────────────────────
  app.delete("/api/approvals/:id", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseInt(req.params.id);
      const [existing] = await db
        .select()
        .from(approvalRequests)
        .where(and(eq(approvalRequests.id, id), eq(approvalRequests.companyId, companyId)));
      if (!existing) return res.status(404).json({ message: "Request not found" });
      if (existing.requestedByUserId !== userId) {
        return res.status(403).json({ message: "You can only cancel your own requests" });
      }
      if (existing.status !== "pending") {
        return res.status(400).json({ message: "Only pending requests can be cancelled" });
      }
      await db.update(approvalRequests).set({ status: "cancelled" }).where(eq(approvalRequests.id, id));
      res.json({ ok: true });
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });
}
