import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { pool } from "../db";
import { requireAuth } from "../auth";

// ── Internal: run all alert checks for one company ────────────────────────────
async function upsertAlert(params: {
  companyId: number;
  alertType: string;
  severity: "info" | "warning" | "critical";
  title: string;
  message: string;
  targetRecordId?: number | null;
  metadata?: unknown;
}) {
  const existing = await pool.query(
    `SELECT id FROM business_alerts
     WHERE company_id = $1 AND alert_type = $2
       AND target_record_id IS NOT DISTINCT FROM $3
       AND status = 'open'`,
    [params.companyId, params.alertType, params.targetRecordId ?? null]
  );
  if (existing.rows.length === 0) {
    await pool.query(
      `INSERT INTO business_alerts
         (company_id, alert_type, severity, title, message, target_record_id, metadata, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')`,
      [
        params.companyId,
        params.alertType,
        params.severity,
        params.title,
        params.message,
        params.targetRecordId ?? null,
        params.metadata ? JSON.stringify(params.metadata) : null,
      ]
    );
  } else {
    // Update title/message in case counts changed
    await pool.query(
      `UPDATE business_alerts SET title = $1, message = $2, metadata = $3
       WHERE company_id = $4 AND alert_type = $5
         AND target_record_id IS NOT DISTINCT FROM $6 AND status = 'open'`,
      [
        params.title,
        params.message,
        params.metadata ? JSON.stringify(params.metadata) : null,
        params.companyId,
        params.alertType,
        params.targetRecordId ?? null,
      ]
    );
  }
}

async function autoResolve(companyId: number, alertType: string, targetRecordId?: number | null) {
  await pool.query(
    `UPDATE business_alerts
     SET status = 'resolved', resolved_at = NOW()
     WHERE company_id = $1 AND alert_type = $2
       AND target_record_id IS NOT DISTINCT FROM $3
       AND status = 'open'`,
    [companyId, alertType, targetRecordId ?? null]
  );
}

export async function runAlertChecks(companyId: number): Promise<void> {
  // ── Check 1: Negative stock ────────────────────────────────────────────────
  const negStockRes = await pool.query(
    `SELECT si.name, i.quantity, l.name AS location
     FROM inventory i
     JOIN stock_items si ON si.id = i.stock_item_id
     JOIN locations l   ON l.id  = i.location_id
     WHERE l.company_id = $1 AND i.quantity < 0
     ORDER BY i.quantity ASC
     LIMIT 20`,
    [companyId]
  );
  if (negStockRes.rows.length > 0) {
    const preview = negStockRes.rows
      .slice(0, 5)
      .map((r) => `${r.name} (${r.quantity} @ ${r.location})`)
      .join(", ");
    await upsertAlert({
      companyId,
      alertType: "negative_stock",
      severity: "warning",
      title: `${negStockRes.rows.length} item(s) with negative stock`,
      message: preview + (negStockRes.rows.length > 5 ? " …and more" : ""),
      metadata: { count: negStockRes.rows.length, items: negStockRes.rows },
    });
  } else {
    await autoResolve(companyId, "negative_stock");
  }

  // ── Check 2: Pending approval requests ────────────────────────────────────
  const pendingRes = await pool.query(
    `SELECT COUNT(*) AS n FROM approval_requests
     WHERE company_id = $1 AND status = 'pending'`,
    [companyId]
  );
  const pendingCount = parseInt(pendingRes.rows[0]?.n ?? "0", 10);
  if (pendingCount > 0) {
    await upsertAlert({
      companyId,
      alertType: "approval_pending",
      severity: "info",
      title: `${pendingCount} pending approval request${pendingCount !== 1 ? "s" : ""}`,
      message: `${pendingCount} action${pendingCount !== 1 ? "s" : ""} are awaiting review by an Admin or Developer.`,
      metadata: { count: pendingCount },
    });
  } else {
    await autoResolve(companyId, "approval_pending");
  }

  // ── Check 3: Large cash / bank withdrawals in the last 7 days ─────────────
  // Voucher narration lives on voucher_entries; voucher headers carry description.
  // Keep the alert query on the canonical current column names so a malformed-write
  // sweep cannot turn this maintenance endpoint into a 500 after schema changes.
  const LARGE_THRESHOLD = 50000;
  const largeRes = await pool.query(
    `SELECT v.id, v.voucher_number, COALESCE(ve.narration, v.description) AS narration,
            ve.credit_amount AS amount, la.name AS account
     FROM vouchers v
     JOIN voucher_entries ve ON ve.voucher_id = v.id
     JOIN ledger_accounts la ON la.id = ve.ledger_account_id AND la.company_id = v.company_id
     WHERE v.company_id = $1
       AND la.account_type IN ('Cash', 'Bank')
       AND COALESCE(ve.credit_amount, 0)::numeric > $2
       AND v.voucher_date >= CURRENT_DATE - INTERVAL '7 days'
       AND v.deleted_at IS NULL
     ORDER BY COALESCE(ve.credit_amount, 0)::numeric DESC
     LIMIT 10`,
    [companyId, LARGE_THRESHOLD]
  );
  const seenVoucherIds = new Set<number>();
  for (const row of largeRes.rows) {
    if (seenVoucherIds.has(row.id)) continue;
    seenVoucherIds.add(row.id);
    await upsertAlert({
      companyId,
      alertType: "large_cash_withdrawal",
      severity: "warning",
      targetRecordId: row.id,
      title: `Large withdrawal: ${parseFloat(row.amount).toLocaleString()}`,
      message: `Voucher ${row.voucher_number ?? row.id}: "${row.narration ?? "No narration"}" — ${parseFloat(row.amount).toLocaleString()} from ${row.account}`,
      metadata: { voucherId: row.id, amount: row.amount },
    });
  }

  // ── Check 4: Unreconciled import errors (import_batches with invalid rows) ─
  const importErrorRes = await pool.query(
    `SELECT id, import_type, file_name, invalid_rows, created_at
     FROM import_batches
     WHERE company_id = $1 AND invalid_rows > 0 AND status = 'applied'
       AND created_at >= NOW() - INTERVAL '7 days'
     ORDER BY created_at DESC
     LIMIT 5`,
    [companyId]
  );
  if (importErrorRes.rows.length > 0) {
    const total = importErrorRes.rows.reduce((s: number, r) => s + parseInt(r.invalid_rows, 10), 0);
    await upsertAlert({
      companyId,
      alertType: "import_errors",
      severity: "info",
      title: `${total} row error(s) in recent imports`,
      message: importErrorRes.rows.map((r) => `${r.file_name} (${r.invalid_rows} errors)`).join(", "),
      metadata: { batches: importErrorRes.rows },
    });
  } else {
    await autoResolve(companyId, "import_errors");
  }
}

// ── Route registration ─────────────────────────────────────────────────────────
export function registerBusinessAlertRoutes(app: Express) {
  // GET /api/business-alerts — list alerts for current company
  app.get("/api/business-alerts", requireAuth, async (req, res) => {
    try {
      const role = req.session.currentRole ?? "";
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!["Admin", "Developer", "Owner", "Manager"].includes(role)) {
        return res.status(403).json({ message: "Access denied" });
      }
      const { status } = req.query;
      const params: unknown[] = [companyId];
      let query = `SELECT * FROM business_alerts WHERE company_id = $1`;
      if (status && typeof status === "string") {
        query += ` AND status = $2`;
        params.push(status);
      }
      query += ` ORDER BY created_at DESC LIMIT 200`;
      const result = await pool.query(query, params);
      res.json(result.rows);
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // GET /api/business-alerts/summary — open alert counts by severity
  app.get("/api/business-alerts/summary", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const result = await pool.query(
        `SELECT severity, COUNT(*) AS count
         FROM business_alerts
         WHERE company_id = $1 AND status = 'open'
         GROUP BY severity`,
        [companyId]
      );
      const summary: Record<string, number> = { critical: 0, warning: 0, info: 0 };
      for (const row of result.rows) {
        summary[row.severity] = parseInt(row.count, 10);
      }
      res.json(summary);
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // POST /api/business-alerts/run-checks — trigger checks manually
  app.post("/api/business-alerts/run-checks", requireAuth, async (req, res) => {
    try {
      const role = req.session.currentRole ?? "";
      if (!["Admin", "Developer", "Owner"].includes(role)) {
        return res.status(403).json({ message: "Access denied" });
      }
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      await runAlertChecks(companyId);
      res.json({ ok: true, message: "Alert checks completed" });
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // POST /api/business-alerts/:id/dismiss
  app.post("/api/business-alerts/:id/dismiss", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const userId = req.session.userId!;
      const id = parseInt(req.params.id);
      await pool.query(
        `UPDATE business_alerts
         SET status = 'dismissed', dismissed_by = $1
         WHERE id = $2 AND company_id = $3`,
        [userId, id, companyId]
      );
      res.json({ ok: true });
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // POST /api/business-alerts/:id/resolve
  app.post("/api/business-alerts/:id/resolve", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseInt(req.params.id);
      await pool.query(
        `UPDATE business_alerts
         SET status = 'resolved', resolved_at = NOW()
         WHERE id = $1 AND company_id = $2`,
        [id, companyId]
      );
      res.json({ ok: true });
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // POST /api/business-alerts/:id/reopen
  app.post("/api/business-alerts/:id/reopen", requireAuth, async (req, res) => {
    try {
      const role = req.session.currentRole ?? "";
      if (!["Admin", "Developer"].includes(role)) {
        return res.status(403).json({ message: "Access denied" });
      }
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseInt(req.params.id);
      await pool.query(
        `UPDATE business_alerts
         SET status = 'open', dismissed_by = NULL, resolved_at = NULL
         WHERE id = $1 AND company_id = $2`,
        [id, companyId]
      );
      res.json({ ok: true });
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });
}
