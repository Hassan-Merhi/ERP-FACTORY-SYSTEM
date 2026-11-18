// Extracted from ./aiAgentRoutes.ts to keep that module under the source-size cap.
import { db } from "../db";
import { aiAgentApprovals, aiAgentTasks } from "@shared/schema";
import { and, eq } from "drizzle-orm";
import { runTool, TOOL_REGISTRY, TOOL_REGISTRY_MAP } from "../aiAgentTools";
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

export interface TaskPlan {
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

export async function generateTaskPlan(instruction: string): Promise<TaskPlan> {
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
export async function assertTaskOwner(taskId: number, companyId: number) {
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
export async function executeStep(
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
