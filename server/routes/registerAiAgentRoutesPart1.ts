// Extracted from ./registerAiAgentRoutes.ts
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { db } from "../db";
import { aiAgentApprovals, aiAgentTasks } from "@shared/schema";
import { desc, eq } from "drizzle-orm";
import { requireAuth, requireNonPOS, requireRole } from "../auth";
import { assertTaskOwner, executeStep, generateTaskPlan, type TaskPlan } from "./aiAgentRoutesGenerateTaskPlan";

export function registerAiAgentRoutesPart1(app: Express) {
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
}
