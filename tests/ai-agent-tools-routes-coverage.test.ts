/**
 * AI agent tool executor (runTool) and the task cancel / approve / reject
 * routes, against PostgreSQL inside one rolled-back transaction per test.
 * No LLM is involved: these paths only touch the database.
 */
import { describe, expect, it } from "vitest";

import { runTool, TOOL_REGISTRY_MAP } from "../server/aiAgentTools";
import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const seedItem = (w: FactoryWorld, code: string) =>
  w.one(
    `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2::varchar, $2::text, 'pcs') RETURNING id`,
    [w.companyId, code]
  );

const seedTask = (w: FactoryWorld, plan: unknown, companyId = w.companyId) =>
  w.one(
    `INSERT INTO ai_agent_tasks (company_id, user_id, user_instruction, status, plan_json)
     VALUES ($1, $2, 'do things', 'waiting_for_approval', $3::jsonb) RETURNING id`,
    [companyId, w.userId, JSON.stringify(plan)]
  );

const seedApproval = (w: FactoryWorld, taskId: number, status = "pending", companyId = w.companyId) =>
  w.one(
    `INSERT INTO ai_agent_approvals (task_id, company_id, user_id, action_type, action_label, status)
     VALUES ($1, $2, $3, 'post_voucher', 'Post it', $4) RETURNING id`,
    [taskId, companyId, w.userId, status]
  );

const otherCompany = (w: FactoryWorld) =>
  w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [`${w.tag}X`]);

describe("runTool read tools", () => {
  it("runs every search tool and the business alerts summary for the company", async () => {
    await withFactoryWorld(async (w) => {
      await seedItem(w, `${w.tag}A`);
      const items = await runTool(w.companyId, w.userId, "searchStockItems", { query: w.tag });
      expect(items.ok).toBe(true);
      expect((items.data as { count: number }).count).toBe(1);
      for (const tool of ["searchSuppliers", "searchCustomers", "searchLedgerAccounts", "searchVouchers"]) {
        const res = await runTool(w.companyId, w.userId, tool, {});
        expect(res.ok).toBe(true);
        expect((res.data as { count: number }).count).toBeGreaterThanOrEqual(0);
      }
      const alerts = await runTool(w.companyId, w.userId, "getBusinessAlerts", {});
      expect(alerts.ok).toBe(true);
      expect(alerts.data).toHaveProperty("lowStock");
      expect(alerts.data).toHaveProperty("pricingIssues");
    });
  });

  it("splits item codes into valid and invalid, and answers an empty list without querying", async () => {
    await withFactoryWorld(async (w) => {
      await seedItem(w, `${w.tag}A`);
      const res = await runTool(w.companyId, w.userId, "validateItemCodes", { codes: `${w.tag}A; NOPE-1\nNOPE-2,` });
      expect(res.ok).toBe(true);
      expect(res.data).toMatchObject({
        valid: [{ code: `${w.tag}A` }],
        invalid: ["NOPE-1", "NOPE-2"],
        totalChecked: 3,
        validCount: 1,
        invalidCount: 2,
      });
      const empty = await runTool(w.companyId, w.userId, "validateItemCodes", {});
      expect(empty).toEqual({ ok: true, data: { valid: [], invalid: [], message: "No codes provided" } });
    });
  });

  it("validates import jobs: missing id, another company's job, and the company's own job", async () => {
    await withFactoryWorld(async (w) => {
      expect(await runTool(w.companyId, w.userId, "validateImportJob", {})).toEqual({
        ok: false,
        error: "jobId is required",
      });
      const other = await otherCompany(w);
      const foreign = await w.one(
        `INSERT INTO ai_import_jobs (company_id, user_id, import_type) VALUES ($1, $2, 'items') RETURNING id`,
        [other, w.userId]
      );
      expect(await runTool(w.companyId, w.userId, "validateImportJob", { jobId: foreign })).toEqual({
        ok: false,
        error: `Import job ${foreign} not found`,
      });
      const own = await w.one(
        `INSERT INTO ai_import_jobs (company_id, user_id, import_type, total_rows) VALUES ($1, $2, 'items', 4) RETURNING id`,
        [w.companyId, w.userId]
      );
      const res = await runTool(w.companyId, w.userId, "validateImportJob", { jobId: String(own) });
      expect(res).toMatchObject({ ok: true, data: { id: own, importType: "items", totalRows: 4 } });
    });
  });

  it("points file comparison at the import page and refuses unknown tools", async () => {
    const compare = await runTool(1, "u", "compareExcelFiles", {});
    expect(compare).toMatchObject({ ok: true, data: { suggestion: "/ai-import" } });
    expect(await runTool(1, "u", "dropAllTables", {})).toEqual({ ok: false, error: "Unknown tool: dropAllTables" });
    expect(TOOL_REGISTRY_MAP.size).toBeGreaterThan(0);
  });

  it("turns a thrown error into a failed result", async () => {
    const res = await runTool(Number.NaN, "u", "validateImportJob", { jobId: 1 });
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe("string");
  });
});

describe("runTool draft tools", () => {
  it("prepares a voucher draft with defaults and with explicit fields", async () => {
    const defaults = await runTool(1, "u", "prepareVoucherDraft", {});
    expect(defaults).toMatchObject({ ok: true, requiresApproval: true, actionType: "post_voucher" });
    expect(defaults.previewJson).toMatchObject({ voucherType: "Journal", amount: "0.00", debitAccountId: null });
    expect(defaults.actionLabel).toContain("No description");
    const full = await runTool(1, "u", "prepareVoucherDraft", {
      voucherType: "Payment",
      date: "2026-01-02",
      description: "Rent",
      debitAccountId: 3,
      creditAccountId: 4,
      amount: "12.5",
    });
    expect(full.previewJson).toMatchObject({ voucherType: "Payment", date: "2026-01-02", amount: "12.50" });
    expect(full.actionLabel).toBe("Post Payment voucher — Rent (12.50)");
  });

  it("totals purchase order lines and tolerates a missing item list", async () => {
    const res = await runTool(1, "u", "preparePurchaseOrderDraft", {
      supplierId: 9,
      items: [
        { rate: "2.50", quantity: 4 },
        { rate: "1", quantity: "3" },
      ],
    });
    expect(res.previewJson).toMatchObject({ supplierId: 9, totalAmount: "13.00", itemCount: 2 });
    const empty = await runTool(1, "u", "preparePurchaseOrderDraft", { items: "x" });
    expect(empty.previewJson).toMatchObject({ supplierId: null, totalAmount: "0.00", itemCount: 0 });
  });

  it("prepares price updates and stock adjustments in both directions", async () => {
    const prices = await runTool(1, "u", "preparePriceUpdateDraft", { updates: [{ id: 1 }, { id: 2 }] });
    expect(prices.actionLabel).toBe("Update selling prices for 2 item(s)");
    const none = await runTool(1, "u", "preparePriceUpdateDraft", {});
    expect(none.previewJson).toEqual({ updates: [], count: 0 });
    const add = await runTool(1, "u", "prepareStockAdjustmentDraft", { quantity: "5", reason: "found" });
    expect(add.actionLabel).toBe("Add 5 units — found");
    const remove = await runTool(1, "u", "prepareStockAdjustmentDraft", { quantity: "-2", stockItemId: 7 });
    expect(remove.actionLabel).toBe("Remove 2 units");
    expect(remove.previewJson).toMatchObject({ stockItemId: 7, locationId: null, quantity: -2, reason: "" });
  });
});

describe("AI agent task and approval routes", () => {
  it("refuses bad ids, unknown tasks and other companies' tasks without changing them", async () => {
    await withFactoryWorld(async (w) => {
      expect((await w.agent.delete("/api/ai-agent/tasks/abc")).status).toBe(400);
      expect((await w.agent.delete("/api/ai-agent/tasks/999999999")).status).toBe(404);
      const foreign = await seedTask(w, { steps: [] }, await otherCompany(w));
      const res = await w.agent.delete(`/api/ai-agent/tasks/${foreign}`);
      expect(res.status).toBe(404);
      const [row] = await w.q(`SELECT status FROM ai_agent_tasks WHERE id = $1`, [foreign]);
      expect(row.status).toBe("waiting_for_approval");
      expect((await w.agent.post("/api/ai-agent/approvals/abc/approve")).status).toBe(400);
      expect((await w.agent.post("/api/ai-agent/approvals/abc/reject")).status).toBe(400);
      expect((await w.agent.post("/api/ai-agent/approvals/999999999/approve")).status).toBe(404);
      expect((await w.agent.post("/api/ai-agent/approvals/999999999/reject")).status).toBe(404);
    });
  });

  it("answers a generic 500 when PostgreSQL rejects an id past the int4 range", async () => {
    // One request per world: the failed statement aborts the rolled-back transaction.
    for (const send of [
      (w: FactoryWorld) => w.agent.delete("/api/ai-agent/tasks/99999999999"),
      (w: FactoryWorld) => w.agent.post("/api/ai-agent/approvals/99999999999/approve"),
      (w: FactoryWorld) => w.agent.post("/api/ai-agent/approvals/99999999999/reject"),
    ]) {
      await withFactoryWorld(async (w) => {
        const res = await send(w);
        expect(res.status).toBe(500);
        expect(res.body.message).toBe("Internal server error");
      });
    }
  });

  it("cancels the company's own task", async () => {
    await withFactoryWorld(async (w) => {
      const taskId = await seedTask(w, { steps: [] });
      const res = await w.agent.delete(`/api/ai-agent/tasks/${taskId}`);
      expect(res.status).toBe(200);
      const [row] = await w.q(`SELECT status FROM ai_agent_tasks WHERE id = $1`, [taskId]);
      expect(row.status).toBe("cancelled");
    });
  });

  it("refuses roles outside Admin, Owner and Manager on the approval routes", async () => {
    await withFactoryWorld(async (w) => {
      const taskId = await seedTask(w, { steps: [] });
      const approvalId = await seedApproval(w, taskId);
      const user = await w.agentFor("Normal User");
      expect((await user.post(`/api/ai-agent/approvals/${approvalId}/approve`)).status).toBe(403);
      const [row] = await w.q(`SELECT status FROM ai_agent_approvals WHERE id = $1`, [approvalId]);
      expect(row.status).toBe("pending");
    });
  });

  it("refuses an approval that was already decided", async () => {
    await withFactoryWorld(async (w) => {
      const taskId = await seedTask(w, { steps: [] });
      const done = await seedApproval(w, taskId, "approved");
      const approve = await w.agent.post(`/api/ai-agent/approvals/${done}/approve`);
      expect(approve.status).toBe(409);
      expect(approve.body.message).toBe("Approval is already approved");
      expect((await w.agent.post(`/api/ai-agent/approvals/${done}/reject`)).status).toBe(409);
    });
  });

  it("approves, completes the waiting step and runs the remaining steps until the next approval", async () => {
    await withFactoryWorld(async (w) => {
      const taskId = await seedTask(w, { steps: [] });
      const approvalId = await seedApproval(w, taskId);
      const plan = {
        steps: [
          { id: "1", name: "Draft", tool: "prepareVoucherDraft", params: {}, status: "waiting_approval", approvalId },
          { id: "2", name: "Check", tool: "compareExcelFiles", params: {}, status: "pending" },
          { id: "3", name: "Draft 2", tool: "preparePriceUpdateDraft", params: {}, status: "pending" },
          { id: "4", name: "Later", tool: "compareExcelFiles", params: {}, status: "pending" },
        ],
      };
      await w.q(`UPDATE ai_agent_tasks SET plan_json = $2::jsonb WHERE id = $1`, [taskId, JSON.stringify(plan)]);
      const res = await w.agent.post(`/api/ai-agent/approvals/${approvalId}/approve`);
      expect(res.status).toBe(200);
      expect(res.body.taskStatus).toBe("waiting_for_approval");
      expect(res.body.plan.steps.map((s: { status: string }) => s.status)).toEqual([
        "completed",
        "completed",
        "waiting_approval",
        "pending",
      ]);
      const approvals = await w.q(`SELECT status FROM ai_agent_approvals WHERE task_id = $1 ORDER BY id`, [taskId]);
      expect(approvals.map((a) => a.status)).toEqual(["approved", "pending"]);
    });
  });

  it("marks the task failed when a following step fails, and completed when nothing is left", async () => {
    await withFactoryWorld(async (w) => {
      const failTask = await seedTask(w, { steps: [] });
      const failApproval = await seedApproval(w, failTask);
      await w.q(`UPDATE ai_agent_tasks SET plan_json = $2::jsonb WHERE id = $1`, [
        failTask,
        JSON.stringify({
          steps: [
            { id: "1", tool: "x", params: {}, status: "waiting_approval", approvalId: failApproval },
            { id: "2", tool: "noSuchTool", params: {}, status: "pending" },
            { id: "3", tool: "compareExcelFiles", params: {}, status: "pending" },
          ],
        }),
      ]);
      const failed = await w.agent.post(`/api/ai-agent/approvals/${failApproval}/approve`);
      expect(failed.body.taskStatus).toBe("failed");

      const doneTask = await seedTask(w, { steps: [] });
      const doneApproval = await seedApproval(w, doneTask);
      await w.q(`UPDATE ai_agent_tasks SET plan_json = NULL WHERE id = $1`, [doneTask]);
      const done = await w.agent.post(`/api/ai-agent/approvals/${doneApproval}/approve`);
      expect(done.body.taskStatus).toBe("completed");
      const [row] = await w.q(`SELECT status FROM ai_agent_tasks WHERE id = $1`, [doneTask]);
      expect(row.status).toBe("completed");
    });
  });

  it("rejects: skips the waiting step and cancels the task", async () => {
    await withFactoryWorld(async (w) => {
      const taskId = await seedTask(w, { steps: [] });
      const approvalId = await seedApproval(w, taskId);
      await w.q(`UPDATE ai_agent_tasks SET plan_json = $2::jsonb WHERE id = $1`, [
        taskId,
        JSON.stringify({ steps: [{ id: "1", tool: "x", params: {}, status: "waiting_approval", approvalId }] }),
      ]);
      const res = await w.agent.post(`/api/ai-agent/approvals/${approvalId}/reject`);
      expect(res.status).toBe(200);
      expect(res.body.taskStatus).toBe("cancelled");
      const [task] = await w.q(`SELECT status, plan_json FROM ai_agent_tasks WHERE id = $1`, [taskId]);
      expect(task.status).toBe("cancelled");
      expect(task.plan_json.steps[0]).toMatchObject({ status: "skipped", error: "Rejected by user" });

      const bare = await seedTask(w, { steps: [] });
      await w.q(`UPDATE ai_agent_tasks SET plan_json = NULL WHERE id = $1`, [bare]);
      const bareApproval = await seedApproval(w, bare);
      expect((await w.agent.post(`/api/ai-agent/approvals/${bareApproval}/reject`)).status).toBe(200);
    });
  });
});
