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

export { registerAiAgentRoutes } from "./registerAiAgentRoutes";
