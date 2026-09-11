/**
 * AI Command Center — Agent Routes
 *
 * POST   /api/ai-agent/tasks              — create task + AI plan
 * GET    /api/ai-agent/tasks              — list tasks for company (latest 50)
 * GET    /api/ai-agent/tasks/:id          — task detail + approvals
 * POST   /api/ai-agent/tasks/:id/run      — execute next pending step(s)
 * DELETE /api/ai-agent/tasks/:id          — cancel task
 * POST   /api/ai-agent/approvals/:id/approve — approve an action
 * POST   /api/ai-agent/approvals/:id/reject  — reject an action
 */

import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { db } from "../db";
import { aiAgentTasks, aiAgentApprovals } from "@shared/schema";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth, requireRole, requireNonPOS } from "../auth";
import { TOOL_REGISTRY, TOOL_REGISTRY_MAP, runTool } from "../aiAgentTools";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";

// ── Types ─────────────────────────────────────────────────────────────────────
interface PlanStep {
  id: string;
  name: string;
  tool: string;
  params: Record<string, unknown>;
  requiresApproval: boolean;
  status: "pending" | "running" | "completed" | "failed" | "waiting_approval" | "skipped";
  result?: unknown;
  error?: string;
  approvalId?: number;
  startedAt?: string;
  completedAt?: string;
}

interface TaskPlan {
  taskType: string;
  description: string;
  steps: PlanStep[];
}

// ── AI plan generation ────────────────────────────────────────────────────────
const TOOL_LIST = TOOL_REGISTRY.map(
  (t) => `  - ${t.name} (${t.type}${t.requiresApproval ? ", needs approval" : ""}): ${t.description}`
).join("\n");

const PLAN_SYSTEM_PROMPT = `You are an ERP operations planning assistant. Generate a structured task plan as valid JSON given a user instruction.

Available tools:
${TOOL_LIST}

Rules:
- Read tools run immediately, no approval.
- Draft tools create a preview that the user must approve before anything is written.
- Keep the plan to ≤6 steps, focused and minimal.
- If the instruction is a general question (no write intent), use only read tools.
- Return ONLY a JSON object — no markdown, no explanation.

Required output format:
{
  "taskType": "short_snake_case_identifier",
  "description": "One-sentence description of what will be done",
  "steps": [
    {
      "id": "step_1",
      "name": "Human-readable step name",
      "tool": "toolName",
      "params": {},
      "requiresApproval": false,
      "status": "pending"
    }
  ]
}`;

async function generateTaskPlan(instruction: string): Promise<TaskPlan> {
  const userPrompt = `User instruction: "${instruction}"`;

  // Try Gemini first
  if (process.env.GEMINI_API_KEY) {
    try {
      const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const resp = await genAI.models.generateContent({
        model: "gemini-2.0-flash",
        contents: [{ role: "user", parts: [{ text: `${PLAN_SYSTEM_PROMPT}\n\n${userPrompt}` }] }],
        config: { temperature: 0.15, responseMimeType: "application/json" },
      });
      const text = (resp.text ?? "").replace(/```json\n?|\n?```/g, "").trim();
      const parsed = JSON.parse(text);
      if (parsed.taskType && Array.isArray(parsed.steps)) {
        return normalise(parsed);
      }
    } catch {
      // fall through
    }
  }

  // Try OpenAI
  if (process.env.OPENAI_API_KEY) {
    try {
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const resp = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: PLAN_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.15,
      });
      const parsed = JSON.parse(resp.choices[0]?.message?.content ?? "{}");
      if (parsed.taskType && Array.isArray(parsed.steps)) {
        return normalise(parsed);
      }
    } catch {
      // fall through
    }
  }

  // Fallback: no AI key or parse failed
  return {
    taskType: "general_inquiry",
    description: instruction.slice(0, 120),
    steps: [
      {
        id: "step_1",
        name: "Get business overview and alerts",
        tool: "getBusinessAlerts",
        params: {},
        requiresApproval: false,
        status: "pending",
      },
    ],
  };
}

// Raw plan JSON from the model (or JSON.parse): unvalidated, so every field is
// unknown and asserted at the boundary below. Assertions preserve the current
// runtime values exactly rather than coercing them.
type RawPlanStep = {
  id?: unknown;
  name?: unknown;
  tool?: unknown;
  params?: unknown;
  requiresApproval?: unknown;
};

type RawTaskPlan = {
  taskType?: unknown;
  description?: unknown;
  steps?: unknown;
};

function normalise(raw: RawTaskPlan): TaskPlan {
  const steps = (raw.steps || []) as RawPlanStep[];
  return {
    taskType: String(raw.taskType || "general"),
    description: String(raw.description || ""),
    steps: steps.slice(0, 6).map((s: RawPlanStep, i: number) => {
      const toolDef = TOOL_REGISTRY_MAP.get(s.tool as string);
      return {
        id: (s.id || `step_${i + 1}`) as string,
        name: (s.name || s.tool) as string,
        tool: s.tool as string,
        params: (s.params || {}) as Record<string, unknown>,
        requiresApproval: toolDef?.requiresApproval ?? (s.requiresApproval as boolean | undefined) ?? false,
        status: "pending",
      } satisfies PlanStep;
    }),
  };
}

// ── Ownership guard ───────────────────────────────────────────────────────────
async function assertTaskOwner(taskId: number, companyId: number) {
  const [task] = await db
    .select()
    .from(aiAgentTasks)
    .where(and(eq(aiAgentTasks.id, taskId), eq(aiAgentTasks.companyId, companyId)));
  if (!task) {
    const err = new Error("Task not found");
    (err as { status?: number }).status = 404;
    throw err;
  }
  return task;
}

// ── Step executor — runs one step ─────────────────────────────────────────────
async function executeStep(
  step: PlanStep,
  companyId: number,
  userId: string,
  taskId: number
): Promise<{ step: PlanStep; approvalId?: number }> {
  step.status = "running";
  step.startedAt = new Date().toISOString();

  const result = await runTool(companyId, userId, step.tool, step.params);

  if (!result.ok) {
    step.status = "failed";
    step.error = result.error;
    step.completedAt = new Date().toISOString();
    return { step };
  }

  if (result.requiresApproval) {
    // Create approval row and pause
    const [approval] = await db
      .insert(aiAgentApprovals)
      .values({
        taskId,
        companyId,
        userId,
        actionType: result.actionType || step.tool,
        actionLabel: result.actionLabel || step.name,
        payloadJson: result.payloadJson ?? null,
        previewJson: result.previewJson ?? null,
        status: "pending",
      })
      .returning();

    step.status = "waiting_approval";
    step.result = result.data;
    step.approvalId = approval.id;
    step.completedAt = new Date().toISOString();
    return { step, approvalId: approval.id };
  }

  step.status = "completed";
  step.result = result.data;
  step.completedAt = new Date().toISOString();
  return { step };
}

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
      } catch (_err: unknown) {
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
          Object.assign(step, updatedStep);

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
        const _newTaskStatus = hasMore ? "running" : "completed";

        // If more steps, run them now
        if (hasMore) {
          for (const step of plan.steps) {
            if (step.status !== "pending") continue;

            const { step: updatedStep } = await executeStep(step, companyId, userId, approval.taskId);
            Object.assign(step, updatedStep);

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
