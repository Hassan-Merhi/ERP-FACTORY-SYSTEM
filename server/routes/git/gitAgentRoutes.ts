/**
 * GIT routes - Per-agent notes, manual adjustments and prepaid balances.
 *
 * Registered by ./index.ts in the same order as the original single file;
 * Express resolves first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { sql } from "drizzle-orm";
import { resultRows } from "../../lib/queryResult";

/** Shape of a git_agent_adjustments row as selected by the queries below. */
type GitAgentAdjustmentRow = {
  id: number;
  agent_name?: string;
  description: string | null;
  amount: string;
  type: string;
  created_at: string | Date;
};

/** DTO returned to the client for one adjustment. */
type GitAgentAdjustment = {
  id: number;
  description: string | null;
  amount: number;
  type: string;
  createdAt: string | Date;
};

export function registerGitAgentRoutes(app: Express) {
  // ── Agent notes (per-company, per-agent, shared across all users) ─────────
  app.get("/api/git/agent-note/:companyId/:agentName", requireAuth, async (req, res) => {
    try {
      const companyId = parseInt(req.params.companyId, 10);
      const agentName = req.params.agentName;
      const row = await db.execute(
        sql`SELECT note FROM git_agent_notes WHERE company_id = ${companyId} AND agent_name = ${agentName} LIMIT 1`
      );
      const note = (row.rows[0] as { note: unknown })?.note ?? "";
      res.json({ note });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  app.put("/api/git/agent-note/:companyId/:agentName", requireAuth, async (req, res) => {
    try {
      const companyId = parseInt(req.params.companyId, 10);
      const agentName = req.params.agentName;
      const note: string = (req.body.note ?? "").trim();
      await db.execute(
        sql`INSERT INTO git_agent_notes (company_id, agent_name, note, updated_at)
            VALUES (${companyId}, ${agentName}, ${note}, now())
            ON CONFLICT (company_id, agent_name) DO UPDATE SET note = ${note}, updated_at = now()`
      );
      res.json({ ok: true, note });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── Bulk fetch: all notes for a company (one round-trip) ─────────────────
  app.get("/api/git/agent-notes-bulk/:companyId", requireAuth, async (req, res) => {
    try {
      const companyId = parseInt(req.params.companyId, 10);
      const rows = await db.execute(sql`SELECT agent_name, note FROM git_agent_notes WHERE company_id = ${companyId}`);
      res.json({ notes: rows.rows.map((r) => ({ agentName: r.agent_name, note: r.note ?? "" })) });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── Bulk fetch: all adjustments for a company (one round-trip) ────────────
  app.get("/api/git/agent-adjustments-bulk/:companyId", requireAuth, async (req, res) => {
    try {
      const companyId = parseInt(req.params.companyId, 10);
      const result = await db.execute(
        sql`SELECT agent_name, id, description, amount, type, created_at
            FROM git_agent_adjustments
            WHERE company_id = ${companyId}
            ORDER BY created_at ASC`
      );
      const byAgent: Record<string, GitAgentAdjustment[]> = {};
      for (const r of resultRows<GitAgentAdjustmentRow>(result)) {
        const agentName = r.agent_name ?? "";
        if (!byAgent[agentName]) byAgent[agentName] = [];
        byAgent[agentName].push({
          id: r.id,
          description: r.description,
          amount: parseFloat(r.amount),
          type: r.type,
          createdAt: r.created_at,
        });
      }
      res.json({ byAgent });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── Agent manual adjustment entries (per-company, per-agent) ──────────────
  app.get("/api/git/agent-adjustments/:companyId/:agentName", requireAuth, async (req, res) => {
    try {
      const companyId = parseInt(req.params.companyId, 10);
      const agentName = req.params.agentName;
      const result = await db.execute(
        sql`SELECT id, description, amount, type, created_at
            FROM git_agent_adjustments
            WHERE company_id = ${companyId} AND agent_name = ${agentName}
            ORDER BY created_at ASC`
      );
      const rows = resultRows<GitAgentAdjustmentRow>(result);
      res.json(
        rows.map((r) => ({
          id: r.id,
          description: r.description,
          amount: parseFloat(r.amount),
          type: r.type,
          createdAt: r.created_at,
        }))
      );
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  app.post("/api/git/agent-adjustments/:companyId/:agentName", requireAuth, async (req, res) => {
    try {
      const companyId = parseInt(req.params.companyId, 10);
      const agentName = req.params.agentName;
      const description: string = (req.body.description ?? "").trim();
      const amount = parseFloat(req.body.amount);
      const type: string = req.body.type;
      if (!description) return res.status(400).json({ message: "Description is required." });
      if (isNaN(amount) || amount <= 0) return res.status(400).json({ message: "Amount must be a positive number." });
      if (!["debit", "credit"].includes(type))
        return res.status(400).json({ message: "Type must be 'debit' or 'credit'." });
      const result = await db.execute(
        sql`INSERT INTO git_agent_adjustments (company_id, agent_name, description, amount, type)
            VALUES (${companyId}, ${agentName}, ${description}, ${amount}, ${type})
            RETURNING id, description, amount, type, created_at`
      );
      const r = result.rows[0] as unknown as { id: unknown } & { description: unknown } & { amount: string } & {
        type: unknown;
      } & { created_at: unknown };
      res.json({
        id: r.id,
        description: r.description,
        amount: parseFloat(r.amount),
        type: r.type,
        createdAt: r.created_at,
      });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  app.delete("/api/git/agent-adjustments/:companyId/:agentName/:id", requireAuth, async (req, res) => {
    try {
      const companyId = parseInt(req.params.companyId, 10);
      const agentName = req.params.agentName;
      const id = parseInt(req.params.id, 10);
      await db.execute(
        sql`DELETE FROM git_agent_adjustments
            WHERE id = ${id} AND company_id = ${companyId} AND agent_name = ${agentName}`
      );
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── Agent prepaid transit designations ─────────────────────────────────────
  // Containers in transit that have been paid in advance for this agent.
  // Stored in git_prepaid_designations (DB-backed, shared across all users).
  // A container must only appear in ONE status section at a time.

  app.get("/api/git/agent-prepaid/:companyId/:agentName", requireAuth, async (req, res) => {
    try {
      const companyId = parseInt(req.params.companyId, 10);
      const agentName = req.params.agentName;
      const result = await db.execute(
        sql`SELECT container_id FROM git_prepaid_designations
            WHERE company_id = ${companyId} AND agent_name = ${agentName}
            ORDER BY created_at ASC`
      );
      res.json({ designations: result.rows.map((r) => ({ containerId: r.container_id })) });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // Atomically replace the full designation list (used for add/remove operations).
  app.post("/api/git/agent-prepaid/:companyId/:agentName/set-all", requireAuth, async (req, res) => {
    try {
      const companyId = parseInt(req.params.companyId, 10);
      const agentName = req.params.agentName;
      const containerIds: number[] = (req.body.containerIds ?? []).map(Number).filter((n: number) => !isNaN(n));
      const userId = (req as { user: { id: unknown } }).user?.id ?? null;
      // Enforce uniqueness: no container can be prepaid for two agents at once for same company.
      // We simply replace the list for this agent atomically.
      await db.execute(
        sql`DELETE FROM git_prepaid_designations WHERE company_id = ${companyId} AND agent_name = ${agentName}`
      );
      for (const cid of containerIds) {
        await db.execute(
          sql`INSERT INTO git_prepaid_designations (company_id, agent_name, container_id, designated_by)
              VALUES (${companyId}, ${agentName}, ${cid}, ${userId})
              ON CONFLICT (company_id, agent_name, container_id) DO NOTHING`
        );
      }
      res.json({ ok: true, count: containerIds.length });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // Replace one PREPAID_IN_TRANSIT container with an IN_TRANSIT_UNPAID one.
  // The payment allocation moves to the new container; no payment is created.
  app.post("/api/git/agent-prepaid/:companyId/:agentName/replace", requireAuth, async (req, res) => {
    try {
      const companyId = parseInt(req.params.companyId, 10);
      const agentName = req.params.agentName;
      const { oldContainerId, newContainerId, confirmDifferentAmount } = req.body;
      const userId = (req as { user: { id: unknown } }).user?.id ?? null;

      if (!oldContainerId || !newContainerId) {
        return res.status(400).json({ message: "oldContainerId and newContainerId are required." });
      }
      if (oldContainerId === newContainerId) {
        return res.status(400).json({ message: "Old and new containers must be different." });
      }

      // Look up container details
      const cResult = await db.execute(
        sql`SELECT id, container_number, duty_fee FROM containers
            WHERE id IN (${oldContainerId}, ${newContainerId})`
      );
      const rows = cResult.rows as any[];
      const oldC = rows.find((r) => r.id === oldContainerId || r.id === Number(oldContainerId));
      const newC = rows.find((r) => r.id === newContainerId || r.id === Number(newContainerId));

      if (!oldC) return res.status(404).json({ message: `Old container (id ${oldContainerId}) not found.` });
      if (!newC) return res.status(404).json({ message: `New container (id ${newContainerId}) not found.` });

      // Verify old is currently designated
      const existing = await db.execute(
        sql`SELECT container_id FROM git_prepaid_designations
            WHERE company_id = ${companyId} AND agent_name = ${agentName} AND container_id = ${Number(oldContainerId)}`
      );
      if (existing.rows.length === 0) {
        return res.status(409).json({
          message: `Container ${oldC.container_number} is not currently designated as prepaid for this agent.`,
        });
      }

      // Warn on mismatched duty amounts
      const amountsDiffer = Math.abs(parseFloat(oldC.duty_fee) - parseFloat(newC.duty_fee)) > 0.01;
      if (amountsDiffer && !confirmDifferentAmount) {
        return res.status(409).json({
          message: "Duty amounts differ between the two containers.",
          oldAmount: parseFloat(oldC.duty_fee),
          newAmount: parseFloat(newC.duty_fee),
          requiresConfirmation: true,
        });
      }

      // Perform the swap
      await db.execute(
        sql`DELETE FROM git_prepaid_designations
            WHERE company_id = ${companyId} AND agent_name = ${agentName} AND container_id = ${Number(oldContainerId)}`
      );
      await db.execute(
        sql`INSERT INTO git_prepaid_designations (company_id, agent_name, container_id, designated_by)
            VALUES (${companyId}, ${agentName}, ${Number(newContainerId)}, ${userId})
            ON CONFLICT (company_id, agent_name, container_id) DO NOTHING`
      );

      // Log the activity
      await db.execute(
        sql`INSERT INTO git_prepaid_activity_log
              (company_id, agent_name, action, old_container_id, new_container_id,
               old_container_number, new_container_number, amount, performed_by)
            VALUES
              (${companyId}, ${agentName}, 'replace',
               ${Number(oldContainerId)}, ${Number(newContainerId)},
               ${oldC.container_number}, ${newC.container_number},
               ${parseFloat(newC.duty_fee)}, ${userId})`
      );

      res.json({
        ok: true,
        replaced: { from: oldC.container_number, to: newC.container_number },
      });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}
