/**
 * The AI agent task runners rely on executeStep() updating the plan step in place
 * and returning that same object (the persisted plan is built from plan.steps).
 * This pins that contract for every outcome: failed, waiting for approval and completed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  runTool: vi.fn(),
  returning: vi.fn(async () => [{ id: 77 }]),
}));

vi.mock("../server/aiAgentTools", () => ({
  runTool: h.runTool,
  TOOL_REGISTRY: [],
  TOOL_REGISTRY_MAP: new Map(),
}));
vi.mock("../server/db", () => ({
  db: { insert: () => ({ values: () => ({ returning: h.returning }) }) },
}));

import { executeStep } from "../server/routes/aiAgentRoutesGenerateTaskPlan";

const freshStep = () =>
  ({ id: "s1", name: "Step", tool: "lookup", params: {}, status: "pending" }) as unknown as Parameters<
    typeof executeStep
  >[0];

describe("AI agent executeStep step identity", () => {
  beforeEach(() => {
    h.runTool.mockReset();
  });

  it("returns the same step object when the tool fails", async () => {
    h.runTool.mockResolvedValue({ ok: false, error: "boom" });
    const step = freshStep();
    const result = await executeStep(step, 1, "u1", 9);
    expect(result.step).toBe(step);
    expect(step.status).toBe("failed");
  });

  it("returns the same step object when approval is required", async () => {
    h.runTool.mockResolvedValue({ ok: true, requiresApproval: true, data: { x: 1 } });
    const step = freshStep();
    const result = await executeStep(step, 1, "u1", 9);
    expect(result.step).toBe(step);
    expect(result.approvalId).toBe(77);
    expect(step.status).toBe("waiting_approval");
  });

  it("returns the same step object when the tool completes", async () => {
    h.runTool.mockResolvedValue({ ok: true, data: { y: 2 } });
    const step = freshStep();
    const result = await executeStep(step, 1, "u1", 9);
    expect(result.step).toBe(step);
    expect(step.status).toBe("completed");
  });
});
