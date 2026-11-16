// Extracted from ./aiAgentRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { db } from "../db";
import { aiAgentApprovals, aiAgentTasks } from "@shared/schema";
import { and, desc, eq } from "drizzle-orm";
import { requireAuth, requireNonPOS, requireRole } from "../auth";
import { assertTaskOwner, executeStep, generateTaskPlan, type TaskPlan } from "./aiAgentRoutesGenerateTaskPlan";

// ── Route registration ────────────────────────────────────────────────────────
export function registerAiAgentRoutes(app: Express) {
  // ── POST /api/ai-agent/tasks — create task + generate plan ────────────────
  app.post(
    "/api/ai-agent/tasks",
    requireAuth,
    requireNonPOS,
    requireRole("Admin", "Owner", "Manager"),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        const userId = req.session.userId;
        if (!companyId || !userId) return res.status(400).json({ message: "No company selected" });

        const instruction = String(req.body.instruction || "").trim();
        if (!instruction) return res.status(400).json({ message: "instruction is required" });

        // Generate AI plan
        const plan = await generateTaskPlan(instruction);

        const [task] = await db
          .insert(aiAgentTasks)
          .values({
            companyId,
            userId,
            taskType: plan.taskType,
            userInstruction: instruction,
            status: "planned",
            planJson: plan,
          })
          .returning();

        res.status(201).json({ ...task, plan });
      } catch (err: unknown) {
        res
          .status((err as { status?: number }).status ?? 500)
          .json({ message: (err as { status?: number }).status ? getErrorMessage(err) : "Internal server error" });
      }
    }
  );

  // ── GET /api/ai-agent/tasks — list tasks ─────────────────────────────────
  app.get(
    "/api/ai-agent/tasks",
    requireAuth,
    requireNonPOS,
    requireRole("Admin", "Owner", "Manager"),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const tasks = await db
          .select()
          .from(aiAgentTasks)
          .where(eq(aiAgentTasks.companyId, companyId))
          .orderBy(desc(aiAgentTasks.createdAt))
          .limit(50);

        res.json(tasks);
      } catch {
        res.status(500).json({ message: "Internal server error" });
      }
    }
  );

  // ── GET /api/ai-agent/tasks/:id — task detail + approvals ────────────────
  app.get(
    "/api/ai-agent/tasks/:id",
    requireAuth,
    requireNonPOS,
    requireRole("Admin", "Owner", "Manager"),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const taskId = parseInt(req.params.id);
        if (isNaN(taskId)) return res.status(400).json({ message: "Invalid task id" });

        const task = await assertTaskOwner(taskId, companyId);

        const approvals = await db
          .select()
          .from(aiAgentApprovals)
          .where(eq(aiAgentApprovals.taskId, taskId))
          .orderBy(desc(aiAgentApprovals.createdAt));

        res.json({ ...task, approvals });
      } catch (err: unknown) {
        res
          .status((err as { status?: number }).status ?? 500)
          .json({ message: (err as { status?: number }).status ? getErrorMessage(err) : "Internal server error" });
      }
    }
  );

  // ── POST /api/ai-agent/tasks/:id/run — execute pending steps ─────────────
  // Runs all consecutive read-only steps, then stops at the first approval step.
  app.post(
    "/api/ai-agent/tasks/:id/run",
    requireAuth,
    requireNonPOS,
    requireRole("Admin", "Owner", "Manager"),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        const userId = req.session.userId;
        if (!companyId || !userId) return res.status(400).json({ message: "No company selected" });

        const taskId = parseInt(req.params.id);
        if (isNaN(taskId)) return res.status(400).json({ message: "Invalid task id" });

        const task = await assertTaskOwner(taskId, companyId);

        if (["completed", "failed", "cancelled"].includes(task.status)) {
          return res.status(409).json({ message: `Task is already ${task.status}` });
        }
        if (task.status === "waiting_for_approval") {
          return res.status(409).json({ message: "Task is waiting for an approval" });
        }

        const plan = (task.planJson ?? { steps: [] }) as TaskPlan;
        if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
          await db
            .update(aiAgentTasks)
            .set({ status: "completed", updatedAt: new Date() })
            .where(eq(aiAgentTasks.id, taskId));
          return res.json({ status: "completed", plan });
        }

        // Mark task as running
        await db
          .update(aiAgentTasks)
          .set({ status: "running", updatedAt: new Date() })
          .where(eq(aiAgentTasks.id, taskId));

        let waitingForApproval = false;
        let failedStep = false;
        let approvalId: number | undefined;

        for (const step of plan.steps) {
          if (step.status !== "pending") continue;

          const { step: updatedStep, approvalId: aId } = await executeStep(step, companyId, userId, taskId);
          // executeStep() updates `step` in place and returns that same object.

          if (updatedStep.status === "waiting_approval") {
            waitingForApproval = true;
            approvalId = aId;
            break;
          }
          if (updatedStep.status === "failed") {
            failedStep = true;
            break;
          }
        }

        // Check if all steps are done
        const allDone = plan.steps.every((s) =>
          ["completed", "failed", "skipped", "waiting_approval"].includes(s.status)
        );

        let newStatus: string;
        if (failedStep) {
          newStatus = "failed";
        } else if (waitingForApproval) {
          newStatus = "waiting_for_approval";
        } else if (allDone) {
          newStatus = "completed";
        } else {
          newStatus = "running";
        }

        await db
          .update(aiAgentTasks)
          .set({
            status: newStatus,
            planJson: plan,
            updatedAt: new Date(),
            errorMessage: failedStep ? (plan.steps.find((s) => s.status === "failed")?.error ?? "A step failed") : null,
          })
          .where(eq(aiAgentTasks.id, taskId));

        res.json({ status: newStatus, plan, approvalId });
      } catch (err: unknown) {
        res
          .status((err as { status?: number }).status ?? 500)
          .json({ message: (err as { status?: number }).status ? getErrorMessage(err) : "Internal server error" });
      }
    }
  );

  // ── DELETE /api/ai-agent/tasks/:id — cancel task ─────────────────────────
  app.delete(
    "/api/ai-agent/tasks/:id",
    requireAuth,
    requireNonPOS,
    requireRole("Admin", "Owner", "Manager"),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const taskId = parseInt(req.params.id);
        if (isNaN(taskId)) return res.status(400).json({ message: "Invalid task id" });

        await assertTaskOwner(taskId, companyId);

        await db
          .update(aiAgentTasks)
          .set({ status: "cancelled", updatedAt: new Date() })
          .where(eq(aiAgentTasks.id, taskId));

        res.json({ success: true });
      } catch (err: unknown) {
        res
          .status((err as { status?: number }).status ?? 500)
          .json({ message: (err as { status?: number }).status ? getErrorMessage(err) : "Internal server error" });
      }
    }
  );

  // ── POST /api/ai-agent/approvals/:id/approve ─────────────────────────────
  app.post(
    "/api/ai-agent/approvals/:id/approve",
    requireAuth,
    requireNonPOS,
    requireRole("Admin", "Owner", "Manager"),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        const userId = req.session.userId;
        if (!companyId || !userId) return res.status(400).json({ message: "No company selected" });

        const approvalId = parseInt(req.params.id);
        if (isNaN(approvalId)) return res.status(400).json({ message: "Invalid approval id" });

        const [approval] = await db
          .select()
          .from(aiAgentApprovals)
          .where(and(eq(aiAgentApprovals.id, approvalId), eq(aiAgentApprovals.companyId, companyId)));

        if (!approval) return res.status(404).json({ message: "Approval not found" });
        if (approval.status !== "pending")
          return res.status(409).json({ message: `Approval is already ${approval.status}` });

        // Mark approved
        await db
          .update(aiAgentApprovals)
          .set({
            status: "approved",
            approvedBy: userId,
            approvedAt: new Date(),
          })
          .where(eq(aiAgentApprovals.id, approvalId));

        // Mark the waiting step as completed and continue the task
        const task = await assertTaskOwner(approval.taskId, companyId);
        const plan = (task.planJson ?? { steps: [] }) as TaskPlan;

        const waitingStep = plan.steps.find((s) => s.approvalId === approvalId);
        if (waitingStep) {
          waitingStep.status = "completed";
          waitingStep.completedAt = new Date().toISOString();
        }

        // Check if there are more pending steps
        const hasMore = plan.steps.some((s) => s.status === "pending");

        // If more steps, run them now
        if (hasMore) {
          for (const step of plan.steps) {
            if (step.status !== "pending") continue;

            const { step: updatedStep } = await executeStep(step, companyId, userId, approval.taskId);
            // executeStep() updates `step` in place and returns that same object.

            if (updatedStep.status === "waiting_approval") break;
            if (updatedStep.status === "failed") break;
          }
        }

        const allDone = plan.steps.every((s) =>
          ["completed", "failed", "skipped", "waiting_approval"].includes(s.status)
        );
        const hasFailed = plan.steps.some((s) => s.status === "failed");
        const hasWaiting = plan.steps.some((s) => s.status === "waiting_approval");
        const finalStatus = hasFailed
          ? "failed"
          : hasWaiting
            ? "waiting_for_approval"
            : allDone
              ? "completed"
              : "running";

        await db
          .update(aiAgentTasks)
          .set({
            status: finalStatus,
            planJson: plan,
            updatedAt: new Date(),
          })
          .where(eq(aiAgentTasks.id, approval.taskId));

        res.json({ success: true, taskStatus: finalStatus, plan });
      } catch (err: unknown) {
        res
          .status((err as { status?: number }).status ?? 500)
          .json({ message: (err as { status?: number }).status ? getErrorMessage(err) : "Internal server error" });
      }
    }
  );

  // ── POST /api/ai-agent/approvals/:id/reject ───────────────────────────────
  app.post(
    "/api/ai-agent/approvals/:id/reject",
    requireAuth,
    requireNonPOS,
    requireRole("Admin", "Owner", "Manager"),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        const userId = req.session.userId;
        if (!companyId || !userId) return res.status(400).json({ message: "No company selected" });

        const approvalId = parseInt(req.params.id);
        if (isNaN(approvalId)) return res.status(400).json({ message: "Invalid approval id" });

        const [approval] = await db
          .select()
          .from(aiAgentApprovals)
          .where(and(eq(aiAgentApprovals.id, approvalId), eq(aiAgentApprovals.companyId, companyId)));

        if (!approval) return res.status(404).json({ message: "Approval not found" });
        if (approval.status !== "pending")
          return res.status(409).json({ message: `Approval is already ${approval.status}` });

        await db
          .update(aiAgentApprovals)
          .set({
            status: "rejected",
            approvedBy: userId,
            approvedAt: new Date(),
          })
          .where(eq(aiAgentApprovals.id, approvalId));

        // Mark the waiting step as skipped and fail the task gracefully
        const task = await assertTaskOwner(approval.taskId, companyId);
        const plan = (task.planJson ?? { steps: [] }) as TaskPlan;

        const waitingStep = plan.steps.find((s) => s.approvalId === approvalId);
        if (waitingStep) {
          waitingStep.status = "skipped";
          waitingStep.error = "Rejected by user";
        }

        await db
          .update(aiAgentTasks)
          .set({
            status: "cancelled",
            planJson: plan,
            updatedAt: new Date(),
          })
          .where(eq(aiAgentTasks.id, approval.taskId));

        res.json({ success: true, taskStatus: "cancelled" });
      } catch (err: unknown) {
        res
          .status((err as { status?: number }).status ?? 500)
          .json({ message: (err as { status?: number }).status ? getErrorMessage(err) : "Internal server error" });
      }
    }
  );
}
