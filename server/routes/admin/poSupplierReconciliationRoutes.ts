import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import type { Express } from "express";
import { pool } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { getAccessibleCompanyIds } from "../../security/companyAccessBoundary";
import {
  getCompanyRequestRuntimeContext,
  runWithCompanyRequestRuntimeContext,
} from "../../services/security/companyRequestRuntimeContext";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../../services/security/databaseScopeRuntimeContext";
import { retireVouchersWithClient, sessionRetirementActor } from "../../services/accounting/voucherRetirement";
import {
  editPostedVoucherWithClient,
  sendVoucherCorrectionRefusal,
} from "../../services/factory/factoryVoucherCorrection";
import { registerPoSupplierReconciliationRoutesPart1 } from "./registerPoSupplierReconciliationRoutesPart1";
import { validateRequest } from "../../lib/validateRequest";
import { poSupplierReconciliationInput } from "./poSupplierReconciliationSchemas";

/**
 * PO supplier-payable reconciliation and its rollback, split out of
 * adminPoFixRoutes.ts (god-file cap). registerAdminPoFixRoutes calls this
 * first, so the registration order pinned by config/route-manifest.json is
 * unchanged. These routes write through the accounting services and create no
 * voucher rows directly; the legacy PO credit repairs that do stay in
 * adminPoFixRoutes.ts under its existing write-evidence review.
 */
export function registerPoSupplierReconciliationRoutes(app: Express) {
  registerPoSupplierReconciliationRoutesPart1(app);
  registerPoSupplierReconciliationRoutesPart2(app);
}

function registerPoSupplierReconciliationRoutesPart2(app: Express) {
  /**
   * Roll back only the accounting mutations created by the historical PO
   * reconstruction introduced by the reconciliation repair. Dry-run is the
   * default. This deliberately does not touch ordinary PO/import/intercompany
   * vouchers or supplier payments.
   */
  app.post(
    "/api/admin/po-supplier-reconciliation/rollback",
    requireAuth,
    requireRole("Admin"),
    validateRequest(poSupplierReconciliationInput),
    async (req, res) => {
      const selectedCompanyId = Number(req.body?.companyId ?? req.session.currentCompanyId);
      const apply = req.body?.apply === true;
      if (!Number.isInteger(selectedCompanyId) || selectedCompanyId <= 0) {
        return res.status(400).json({ message: "A valid companyId is required" });
      }

      const userId = String(req.session.userId ?? "").trim();
      const requestContext = getCompanyRequestRuntimeContext();
      if (!userId || !requestContext) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const accessibleCompanyIds = await getAccessibleCompanyIds(userId);
      if (!accessibleCompanyIds.has(selectedCompanyId)) {
        return res.status(403).json({ message: "No access to this company" });
      }
      const authorizedCompanyIds = [...accessibleCompanyIds];

      return runWithCompanyRequestRuntimeContext({ ...requestContext, authorizedCompanyIds }, () =>
        runWithDatabaseScopeRuntimeContext(
          createTenantDatabaseScope(requestContext.companyId, authorizedCompanyIds, "authorized-companies"),
          async () => {
            const client = await pool.connect();
            try {
              await client.query("BEGIN");
              if (apply) {
                await client.query("SELECT pg_advisory_xact_lock($1, $2)", [73002, selectedCompanyId]);
              }

              const companyRows = await client.query<{ id: number }>(
                `SELECT id
                     FROM companies
                    WHERE id = $1 OR parent_company_id = $1
                    ORDER BY id`,
                [selectedCompanyId]
              );
              if (!companyRows.rows.some((row) => row.id === selectedCompanyId)) {
                await client.query("ROLLBACK");
                return res.status(404).json({ message: "Company not found" });
              }
              const companyIds = companyRows.rows.map((row) => row.id);

              // These names/descriptions were introduced only by the historical
              // reconstruction repair. Keep the predicate intentionally narrow.
              const generated = await client.query<{
                id: number;
                company_id: number;
                voucher_number: string;
                total_amount: string;
              }>(
                `SELECT id, company_id, voucher_number, total_amount
                     FROM vouchers
                    WHERE company_id = ANY($1::int[])
                      AND deleted_at IS NULL
                      AND (
                        voucher_number LIKE 'RECON-PO-%'
                        OR (
                          voucher_number LIKE 'IC-%-RECON-%'
                          AND description ILIKE '%Historical PO reconciliation%'
                        )
                      )
                    ORDER BY id`,
                [companyIds]
              );
              const generatedVoucherIds = generated.rows.map((row) => row.id);

              const insertedEntryRows = await client.query<{
                id: number;
                voucher_id: number;
                supplier_id: number | null;
                credit_amount: string;
                debit_amount: string;
              }>(
                `SELECT ve.id, ve.voucher_id, ve.supplier_id, ve.credit_amount, ve.debit_amount
                     FROM voucher_entries ve
                     JOIN vouchers v ON v.id = ve.voucher_id
                    WHERE v.company_id = ANY($1::int[])
                      AND v.deleted_at IS NULL
                      AND ve.narration LIKE 'PO % - Supplier reconciliation'
                      AND NOT (ve.voucher_id = ANY($2::int[]))
                    ORDER BY ve.id`,
                [companyIds, generatedVoucherIds.length ? generatedVoucherIds : [-1]]
              );

              const impactRows = await client.query<{
                supplier_id: number | null;
                supplier_name: string | null;
                balance_increase: string;
              }>(
                `WITH rollback_entries AS (
                      SELECT ve.supplier_id,
                             ve.credit_amount::numeric - ve.debit_amount::numeric AS net
                        FROM voucher_entries ve
                       WHERE ve.voucher_id = ANY($2::int[])
                      UNION ALL
                      SELECT ve.supplier_id,
                             ve.credit_amount::numeric - ve.debit_amount::numeric AS net
                        FROM voucher_entries ve
                        JOIN vouchers v ON v.id = ve.voucher_id
                       WHERE v.company_id = ANY($1::int[])
                         AND v.deleted_at IS NULL
                         AND ve.narration LIKE 'PO % - Supplier reconciliation'
                         AND NOT (ve.voucher_id = ANY($2::int[]))
                    )
                    SELECT re.supplier_id,
                           s.legal_name AS supplier_name,
                           COALESCE(SUM(re.net), 0)::text AS balance_increase
                      FROM rollback_entries re
                      LEFT JOIN suppliers s ON s.id = re.supplier_id
                     WHERE re.supplier_id IS NOT NULL
                     GROUP BY re.supplier_id, s.legal_name
                     ORDER BY ABS(COALESCE(SUM(re.net), 0)) DESC`,
                [companyIds, generatedVoucherIds.length ? generatedVoucherIds : [-1]]
              );

              const linkedPoRows = generatedVoucherIds.length
                ? await client.query<{ count: string }>(
                    "SELECT COUNT(*)::text AS count FROM purchase_orders WHERE voucher_id = ANY($1::int[])",
                    [generatedVoucherIds]
                  )
                : { rows: [{ count: "0" }] };

              // A prior reconciliation version could also reroute a legacy
              // "intercompany credit" entry in place. We cannot restore the
              // original ledger_account_id with certainty, so report these
              // separately instead of guessing.
              const reroutedCandidates = await client.query<{
                id: number;
                voucher_id: number;
                supplier_id: number | null;
                credit_amount: string;
                narration: string | null;
              }>(
                `SELECT ve.id, ve.voucher_id, ve.supplier_id, ve.credit_amount, ve.narration
                     FROM voucher_entries ve
                     JOIN vouchers v ON v.id = ve.voucher_id
                    WHERE v.company_id = ANY($1::int[])
                      AND v.deleted_at IS NULL
                      AND ve.supplier_id IS NOT NULL
                      AND ve.credit_amount::numeric > 0
                      AND ve.narration ILIKE '%intercompany credit%'
                      AND NOT (ve.voucher_id = ANY($2::int[]))
                    ORDER BY ve.id`,
                [companyIds, generatedVoucherIds.length ? generatedVoucherIds : [-1]]
              );

              let resetPoLinks = 0;
              let removedInsertedEntries = 0;
              let removedGeneratedVouchers = 0;

              if (apply) {
                if (generatedVoucherIds.length > 0) {
                  const resetResult = await client.query(
                    "UPDATE purchase_orders SET voucher_id = NULL WHERE voucher_id = ANY($1::int[])",
                    [generatedVoucherIds]
                  );
                  resetPoLinks = resetResult.rowCount ?? 0;
                }

                if (insertedEntryRows.rows.length > 0) {
                  // Phase 22 (C), G4: each voucher's inserted lines go in an audited
                  // edit of that voucher (refused, 409, in a closed period).
                  const byVoucher = new Map<number, number[]>();
                  for (const row of insertedEntryRows.rows) {
                    byVoucher.set(row.voucher_id, [...(byVoucher.get(row.voucher_id) ?? []), row.id]);
                  }
                  for (const [voucherId, entryIds] of byVoucher) {
                    const owner = await client.query<{ company_id: number }>(
                      "SELECT company_id FROM vouchers WHERE id = $1",
                      [voucherId]
                    );
                    await editPostedVoucherWithClient(
                      client,
                      {
                        companyId: Number(owner.rows[0]?.company_id ?? selectedCompanyId),
                        voucherId,
                        reason: "po-supplier-reconciliation-rollback",
                        actor: { userId: req.session.userId, username: req.session.username },
                      },
                      async () => {
                        const deleteInserted = await client.query(
                          "DELETE FROM voucher_entries WHERE id = ANY($1::int[])",
                          [entryIds]
                        );
                        removedInsertedEntries += deleteInserted.rowCount ?? 0;
                      }
                    );
                  }
                }

                if (generatedVoucherIds.length > 0) {
                  // Wave 16 (A): retired (soft delete with their lines, audited in
                  // this transaction, numbers released), not hard-deleted.
                  const retired = await retireVouchersWithClient(client, {
                    voucherIds: generatedVoucherIds,
                    reason: "po-supplier-reconciliation-rollback",
                    actor: sessionRetirementActor(req),
                  });
                  removedGeneratedVouchers = retired.length;
                }

                await client.query(
                  `INSERT INTO audit_log
                      (user_id, username, company_id, action, table_name, record_identifier, changes)
                     VALUES ($1, $2, $3, 'rollback', 'po_supplier_payables', $4, $5::jsonb)`,
                  [
                    req.session.userId,
                    req.session.username || "unknown",
                    selectedCompanyId,
                    `po-supplier-reconciliation-rollback:${selectedCompanyId}`,
                    JSON.stringify({
                      generatedVouchers: generatedVoucherIds.length,
                      insertedEntries: insertedEntryRows.rows.length,
                      removedInsertedEntries: insertedEntryRows.rows,
                      resetPoLinks,
                      reroutedCandidates: reroutedCandidates.rows.length,
                    }),
                  ]
                );
                await client.query("COMMIT");
              } else {
                await client.query("ROLLBACK");
              }

              return res.json({
                dryRun: !apply,
                selectedCompanyId,
                companies: companyIds,
                generatedVouchers: generated.rows.length,
                insertedReconciliationEntries: insertedEntryRows.rows.length,
                linkedPoRows: Number(linkedPoRows.rows[0]?.count ?? "0"),
                impactBySupplier: impactRows.rows,
                reroutedCandidates: reroutedCandidates.rows,
                resetPoLinks,
                removedInsertedEntries,
                removedGeneratedVouchers,
              });
            } catch (error: unknown) {
              await client.query("ROLLBACK").catch(() => undefined);
              if (sendVoucherCorrectionRefusal(res, error)) return;
              logger.error("PO supplier reconciliation rollback failed", { error });
              return res.status(500).json({ message: getErrorMessage(error) });
            } finally {
              client.release();
            }
          }
        )
      );
    }
  );
}
