import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { firstRow } from "../../lib/queryResult";
import { requireSpCompany } from "./spHelpers";
import { ensureSpOffloadReversalStorage } from "./spOffloadLifecycleRoutes";

function first(result: unknown): Record<string, unknown> {
  return (firstRow(result) ?? {}) as Record<string, unknown>;
}

export function registerSpChargeReconciliationRoutes(app: Express): void {
  app.get("/api/sp/reconciliation/charges", requireAuth, requireRole("Admin"), async (req: Request, res: Response) => {
    try {
      await ensureSpOffloadReversalStorage();
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;

      const summary = first(
        await db.execute(sql`
          WITH active_offloads AS (
            SELECT o.*
            FROM sp_offloads o
            WHERE o.company_id = ${companyId}
              AND NOT EXISTS (
                SELECT 1 FROM sp_offload_reversals r WHERE r.offload_id = o.id
              )
          ),
          charge_totals AS (
            SELECT o.id AS offload_id,
                   o.container_id,
                   o.total_landed_cost_usd::numeric AS expected_landed,
                   COALESCE(SUM(c.amount_usd::numeric), 0) AS recorded_landed
            FROM active_offloads o
            LEFT JOIN sp_offload_charges c
              ON c.offload_id = o.id AND c.company_id = o.company_id
            GROUP BY o.id, o.container_id, o.total_landed_cost_usd
          ),
          parent_expected AS (
            SELECT o.container_id, COALESCE(SUM(c.amount_usd::numeric), 0) AS amount
            FROM active_offloads o
            JOIN sp_offload_charges c
              ON c.offload_id = o.id AND c.company_id = o.company_id
            WHERE c.charge_type = 'parent_agent'
            GROUP BY o.container_id
          ),
          parent_posted AS (
            SELECT substring(v.voucher_number from 'SP-AGENT-([0-9]+)-')::integer AS container_id,
                   COALESCE(MAX(v.total_amount::numeric), 0) AS amount
            FROM vouchers v
            WHERE v.source_module = 'SP'
              AND v.voucher_number LIKE 'SP-AGENT-%'
              AND v.voucher_number NOT LIKE 'SP-AGENT-REV-%'
              AND v.deleted_at IS NULL
            GROUP BY substring(v.voucher_number from 'SP-AGENT-([0-9]+)-')::integer
          ),
          voucher_balance AS (
            SELECT v.id,
                   COALESCE(SUM(ve.debit_amount::numeric), 0) AS debit,
                   COALESCE(SUM(ve.credit_amount::numeric), 0) AS credit
            FROM vouchers v
            JOIN voucher_entries ve ON ve.voucher_id = v.id
            WHERE v.source_module = 'SP'
              AND v.deleted_at IS NULL
              AND (v.company_id = ${companyId} OR v.voucher_number LIKE 'SP-AGENT-%')
            GROUP BY v.id
          ),
          reversal_totals AS (
            SELECT r.id,
                   COALESCE((
                     SELECT SUM(ve.debit_amount::numeric)
                     FROM voucher_entries ve
                     WHERE ve.voucher_id IN (
                       SELECT jsonb_array_elements_text(r.voucher_ids_original)::integer
                     )
                   ), 0) AS original_debit,
                   COALESCE((
                     SELECT SUM(ve.credit_amount::numeric)
                     FROM voucher_entries ve
                     WHERE ve.voucher_id IN (
                       SELECT jsonb_array_elements_text(r.voucher_ids_original)::integer
                     )
                   ), 0) AS original_credit,
                   COALESCE((
                     SELECT SUM(ve.debit_amount::numeric)
                     FROM voucher_entries ve
                     WHERE ve.voucher_id IN (
                       SELECT jsonb_array_elements_text(r.voucher_ids_reversal)::integer
                     )
                   ), 0) AS reversal_debit,
                   COALESCE((
                     SELECT SUM(ve.credit_amount::numeric)
                     FROM voucher_entries ve
                     WHERE ve.voucher_id IN (
                       SELECT jsonb_array_elements_text(r.voucher_ids_reversal)::integer
                     )
                   ), 0) AS reversal_credit
            FROM sp_offload_reversals r
            WHERE r.company_id = ${companyId}
          )
          SELECT
            (SELECT COUNT(*)::int FROM charge_totals
              WHERE ABS(expected_landed - recorded_landed) > 0.01
            ) AS landed_charge_mismatch_count,
            (SELECT COUNT(*)::int FROM sp_offload_charges c
              JOIN active_offloads o ON o.id = c.offload_id
              WHERE c.charge_type = 'prepaid_used'
                AND (c.prepaid_charge_id IS NULL OR NOT EXISTS (
                  SELECT 1 FROM sp_prepaid_charges p
                  WHERE p.id = c.prepaid_charge_id AND p.company_id = ${companyId}
                ))
            ) AS prepaid_reference_mismatch_count,
            (SELECT COUNT(*)::int FROM sp_prepaid_charges p
              WHERE p.company_id = ${companyId}
                AND (p.amount_used_usd::numeric < -0.0001
                  OR p.amount_used_usd::numeric > p.amount_paid_usd::numeric + 0.0001)
            ) AS prepaid_balance_mismatch_count,
            (SELECT COUNT(*)::int FROM sp_offload_charges c
              JOIN active_offloads o ON o.id = c.offload_id
              WHERE c.charge_type = 'paid_now' AND c.credit_bank_account_id IS NULL
            ) AS paid_now_reference_mismatch_count,
            (SELECT COUNT(*)::int FROM sp_offload_charges c
              JOIN active_offloads o ON o.id = c.offload_id
              WHERE c.charge_type IN ('unpaid_payable', 'other')
                AND c.credit_ledger_account_id IS NULL
            ) AS ledger_reference_mismatch_count,
            (SELECT COUNT(*)::int FROM sp_offload_charges c
              JOIN active_offloads o ON o.id = c.offload_id
              WHERE c.charge_type = 'parent_agent'
                AND c.credit_ledger_account_id IS NULL
            ) AS parent_agent_reference_mismatch_count,
            (SELECT COUNT(*)::int
             FROM parent_expected e
             LEFT JOIN parent_posted p ON p.container_id = e.container_id
             WHERE ABS(e.amount - COALESCE(p.amount, 0)) > 0.01
            ) AS parent_agent_amount_mismatch_count,
            (SELECT COUNT(*)::int FROM voucher_balance WHERE ABS(debit - credit) > 0.0001)
              AS unbalanced_voucher_count,
            (SELECT COUNT(*)::int FROM reversal_totals
              WHERE ABS(original_debit - reversal_credit) > 0.0001
                 OR ABS(original_credit - reversal_debit) > 0.0001
            ) AS reversal_amount_mismatch_count,
            (SELECT COUNT(*)::int FROM sp_offload_charges c
              JOIN active_offloads o ON o.id = c.offload_id
              WHERE c.charge_type NOT IN (
                'prepaid_used', 'paid_now', 'unpaid_payable', 'invoice_freight',
                'supplier_freight', 'other', 'parent_agent'
              )
            ) AS unknown_charge_type_count
        `)
      );

      const checks = {
        landedChargeTotals: Number(summary.landed_charge_mismatch_count ?? 0),
        prepaidReferences: Number(summary.prepaid_reference_mismatch_count ?? 0),
        prepaidBalances: Number(summary.prepaid_balance_mismatch_count ?? 0),
        paidNowReferences: Number(summary.paid_now_reference_mismatch_count ?? 0),
        payableAndOtherLedgerReferences: Number(summary.ledger_reference_mismatch_count ?? 0),
        parentAgentReferences: Number(summary.parent_agent_reference_mismatch_count ?? 0),
        parentAgentAmounts: Number(summary.parent_agent_amount_mismatch_count ?? 0),
        balancedVouchers: Number(summary.unbalanced_voucher_count ?? 0),
        exactReversalAmounts: Number(summary.reversal_amount_mismatch_count ?? 0),
        unknownChargeTypes: Number(summary.unknown_charge_type_count ?? 0),
      };
      const mismatchCount = Object.values(checks).reduce((sum, count) => sum + count, 0);

      res.json({
        status: mismatchCount === 0 ? "PASS" : "FAIL",
        mismatchCount,
        checks,
        supportedChargeTypes: [
          "prepaid_used",
          "paid_now",
          "unpaid_payable",
          "invoice_freight",
          "supplier_freight",
          "other",
          "parent_agent",
        ],
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
