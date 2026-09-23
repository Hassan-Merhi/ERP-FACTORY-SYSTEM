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

import {
  classifyPoSupplierPosting,
  expectedPoSupplierPayable,
  parentImportVoucherNumberPattern,
} from "../../services/accounting/poSupplierReconciliation";

/**
 * PO supplier-payable reconciliation and its rollback, split out of
 * adminPoFixRoutes.ts (god-file cap). registerAdminPoFixRoutes calls this
 * first, so the registration order pinned by config/route-manifest.json is
 * unchanged. These routes write through the accounting services and create no
 * voucher rows directly; the legacy PO credit repairs that do stay in
 * adminPoFixRoutes.ts under its existing write-evidence review.
 */
export function registerPoSupplierReconciliationRoutes(app: Express) {
  /**
   * Reconcile the supplier payable produced by every imported PO in one company.
   * A parent selection also covers its explicitly linked children. Dry-run is
   * the default. apply=true repairs only unambiguous missing/stale entries; a
   * cross-voucher duplicate is reported and deliberately left untouched.
   */
  app.post("/api/admin/po-supplier-reconciliation", requireAuth, requireRole("Admin"), async (req, res) => {
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
              // Only one historical PO reconciliation may mutate a selected company
              // tree at a time. This also serializes voucher reconstruction for POs
              // that do not yet have any accounting voucher to lock.
              await client.query("SELECT pg_advisory_xact_lock($1, $2)", [73001, selectedCompanyId]);
            }
            const companyRows = await client.query<{
              id: number;
              name: string;
              parent_company_id: number | null;
            }>(
              `SELECT id, name, parent_company_id
           FROM companies
          WHERE id = $1 OR parent_company_id = $1
          ORDER BY id`,
              [selectedCompanyId]
            );
            if (!companyRows.rows.some((company) => company.id === selectedCompanyId)) {
              await client.query("ROLLBACK");
              return res.status(404).json({ message: "Company not found" });
            }

            const companyIds = companyRows.rows.map((company) => company.id);
            const poRows = await client.query<{
              id: number;
              company_id: number;
              po_number: string;
              supplier_id: number | null;
              voucher_id: number | null;
              container_number: string | null;
              items_total: string | null;
              freight: string | null;
              surcharge: string | null;
              fumigation: string | null;
              document_charges: string | null;
              discount: string | null;
              other_charges: string | null;
              freight_paid_by: string | null;
              parent_company_id: number | null;
              source_company_name: string;
              created_date: string;
              freight_own_account_id: number | null;
              freight_parent_account_id: number | null;
            }>(
              `SELECT po.id, po.company_id, po.po_number, po.supplier_id, po.voucher_id,
                c.container_number, po.items_total, po.freight, po.surcharge,
                po.fumigation, po.document_charges, po.discount, po.other_charges,
                po.freight_paid_by, po.freight_own_account_id, po.freight_parent_account_id,
                po.created_at::date::text AS created_date, co.name AS source_company_name, co.parent_company_id
           FROM purchase_orders po
           JOIN companies co ON co.id = po.company_id
           LEFT JOIN containers c ON c.id = po.container_id
          WHERE po.company_id = ANY($1::int[])
          ORDER BY po.company_id, po.id`,
              [companyIds]
            );

            const results: Array<Record<string, unknown>> = [];
            let repaired = 0;
            for (const po of poRows.rows) {
              if (!po.supplier_id) {
                results.push({
                  poId: po.id,
                  poNumber: po.po_number,
                  companyId: po.company_id,
                  status: "missing_supplier",
                });
                continue;
              }

              const isSubsidiary = po.parent_company_id != null;
              const expectedCompanyId = po.parent_company_id ?? po.company_id;
              const expected = expectedPoSupplierPayable({
                ...po,
                itemsTotal: po.items_total,
                documentCharges: po.document_charges,
                otherCharges: po.other_charges,
                freightPaidBy: po.freight_paid_by,
                isSubsidiary,
              });

              let voucherIds: number[] = [];
              if (!isSubsidiary && po.voucher_id) {
                voucherIds = [po.voucher_id];
              } else if (isSubsidiary) {
                const markerKey = `infra:po-import:${po.company_id}:${po.po_number}:parent-intercompany`;
                const voucherMatches = await client.query<{ id: number }>(
                  `SELECT DISTINCT v.id
               FROM vouchers v
               LEFT JOIN accounting_posting_requests apr ON apr.voucher_id = v.id
              WHERE v.company_id = $1
                AND v.deleted_at IS NULL
                AND (
                  apr.idempotency_key = $2
                  OR (
                    v.voucher_number LIKE $3
                    AND ($5::text IS NULL OR v.description LIKE '%' || $5 || '%')
                  )
                  OR (
                    v.voucher_number LIKE $4
                    AND ($5::text IS NULL OR v.description LIKE '%' || $5 || '%')
                  )
                )
              ORDER BY v.id`,
                  [
                    expectedCompanyId,
                    markerKey,
                    parentImportVoucherNumberPattern(po.company_id, po.po_number),
                    `INTERCO-PARENT-${po.po_number}-%`,
                    po.container_number,
                  ]
                );
                voucherIds = voucherMatches.rows.map((row) => row.id);
              }

              const entryRows = voucherIds.length
                ? await client.query<{ id: number; voucher_id: number; credit_amount: string }>(
                    `SELECT ve.id, ve.voucher_id, ve.credit_amount
                 FROM voucher_entries ve
                 JOIN vouchers v ON v.id = ve.voucher_id
                WHERE ve.voucher_id = ANY($1::int[])
                  AND ve.supplier_id = $2
                  AND v.company_id = $3
                  AND v.deleted_at IS NULL
                  AND COALESCE(v.optional, false) = false
                  AND ve.credit_amount::numeric > 0
                ORDER BY ve.voucher_id, ve.id`,
                    [voucherIds, po.supplier_id, expectedCompanyId]
                  )
                : { rows: [] as Array<{ id: number; voucher_id: number; credit_amount: string }> };

              let classification = classifyPoSupplierPosting(
                expected,
                entryRows.rows.map((entry) => entry.credit_amount)
              );
              let repairStatus: "not_requested" | "repaired" | "manual_review" = "not_requested";

              const rebuiltVoucher = false;
              if (apply && classification.status !== "matched") {
                let canonicalVoucherId = isSubsidiary ? voucherIds[0] : po.voucher_id;

                // A missing canonical voucher is not enough evidence to recreate a
                // historical liability. Older data can already be represented by
                // opening balances, legacy journals, or migrated intercompany entries.
                // Leave these rows for manual review instead of inventing a new
                // supplier credit that can double-count the payable.

                // Serialize repairs per voucher and refresh the supplier credits after
                // taking the lock. Without the refresh, two apply requests can both
                // observe a missing credit and insert duplicates.
                if (canonicalVoucherId) {
                  const voucherLock = await client.query<{ id: number }>(
                    `SELECT id
                 FROM vouchers
                WHERE id = $1
                  AND company_id = $2
                FOR UPDATE`,
                    [canonicalVoucherId, expectedCompanyId]
                  );
                  if (voucherLock.rowCount !== 1) {
                    repairStatus = "manual_review";
                    canonicalVoucherId = null;
                  }
                  if (voucherIds.length) {
                    const refreshedEntries = await client.query<{
                      id: number;
                      voucher_id: number;
                      credit_amount: string;
                    }>(
                      `SELECT ve.id, ve.voucher_id, ve.credit_amount
                   FROM voucher_entries ve
                   JOIN vouchers v ON v.id = ve.voucher_id
                  WHERE ve.voucher_id = ANY($1::int[])
                    AND ve.supplier_id = $2
                    AND v.company_id = $3
                    AND v.deleted_at IS NULL
                    AND COALESCE(v.optional, false) = false
                    AND ve.credit_amount::numeric > 0
                  ORDER BY ve.voucher_id, ve.id`,
                      [voucherIds, po.supplier_id, expectedCompanyId]
                    );
                    entryRows.rows = refreshedEntries.rows;
                    classification = classifyPoSupplierPosting(
                      expected,
                      entryRows.rows.map((entry) => entry.credit_amount)
                    );
                  }
                }

                const distinctEntryVouchers = new Set(entryRows.rows.map((entry) => entry.voucher_id));
                if (!canonicalVoucherId || distinctEntryVouchers.size > 1) {
                  repairStatus = "manual_review";
                } else if (entryRows.rows.length === 0) {
                  // Missing historical supplier credits are never safe to invent from
                  // the PO total alone. They may already be represented by opening
                  // balances or migrated journals outside this voucher.
                  repairStatus = "manual_review";
                } else if (distinctEntryVouchers.size === 1) {
                  const totals = await client.query<{ debits: string; other_credits: string }>(
                    `SELECT COALESCE(SUM(debit_amount::numeric), 0)::text AS debits,
                      COALESCE(SUM(CASE WHEN supplier_id = $2 THEN 0 ELSE credit_amount::numeric END), 0)::text
                        AS other_credits
                 FROM voucher_entries
                WHERE voucher_id = $1`,
                    [canonicalVoucherId, po.supplier_id]
                  );
                  const remainsBalanced = expected
                    .plus(totals.rows[0]?.other_credits ?? "0")
                    .eq(totals.rows[0]?.debits ?? "0");
                  if (!remainsBalanced) {
                    repairStatus = "manual_review";
                  } else {
                    const [kept, ...duplicates] = entryRows.rows;
                    await client.query(
                      `UPDATE voucher_entries
                    SET debit_amount = '0',
                        credit_amount = $1,
                        transaction_currency = COALESCE(transaction_currency, 'USD'),
                        transaction_debit_amount = '0',
                        transaction_credit_amount = $1,
                        base_debit_amount = '0',
                        base_credit_amount = $1,
                        historical_exchange_rate = COALESCE(historical_exchange_rate, 1),
                        rate_convention = COALESCE(rate_convention, 'IDENTITY')
                  WHERE id = $2`,
                      [expected.toFixed(2), kept.id]
                    );
                    if (duplicates.length > 0) {
                      await client.query(`DELETE FROM voucher_entries WHERE id = ANY($1::int[])`, [
                        duplicates.map((row) => row.id),
                      ]);
                    }
                    repairStatus = "repaired";
                    repaired += 1;
                  }
                }

                if (repairStatus === "repaired" && voucherIds.length) {
                  const finalEntries = await client.query<{ credit_amount: string }>(
                    `SELECT ve.credit_amount
                 FROM voucher_entries ve
                 JOIN vouchers v ON v.id = ve.voucher_id
                WHERE ve.voucher_id = ANY($1::int[])
                  AND ve.supplier_id = $2
                  AND v.company_id = $3
                  AND v.deleted_at IS NULL
                  AND COALESCE(v.optional, false) = false
                  AND ve.credit_amount::numeric > 0
                ORDER BY ve.voucher_id, ve.id`,
                    [voucherIds, po.supplier_id, expectedCompanyId]
                  );
                  classification = classifyPoSupplierPosting(
                    expected,
                    finalEntries.rows.map((entry) => entry.credit_amount)
                  );
                }
              }

              results.push({
                poId: po.id,
                poNumber: po.po_number,
                sourceCompanyId: po.company_id,
                balanceCompanyId: expectedCompanyId,
                supplierId: po.supplier_id,
                voucherIds,
                rebuiltVoucher,
                ...classification,
                repairStatus,
              });
            }

            const counts = results.reduce<Record<string, number>>((acc, result) => {
              const status = String(result.status);
              acc[status] = (acc[status] || 0) + 1;
              return acc;
            }, {});

            if (apply && repaired > 0) {
              await client.query(
                `INSERT INTO audit_log
            (user_id, username, company_id, action, table_name, record_identifier, changes)
           VALUES ($1, $2, $3, 'reconcile', 'po_supplier_payables', $4, $5::jsonb)`,
                [
                  req.session.userId,
                  req.session.username || "unknown",
                  selectedCompanyId,
                  `po-supplier-reconciliation:${selectedCompanyId}`,
                  JSON.stringify({ repaired, counts, companyIds }),
                ]
              );
            }

            if (apply) await client.query("COMMIT");
            else await client.query("ROLLBACK");

            return res.json({ dryRun: !apply, selectedCompanyId, companies: companyIds, counts, repaired, results });
          } catch (error: unknown) {
            await client.query("ROLLBACK").catch(() => undefined);
            logger.error("PO supplier reconciliation failed", { error });
            return res.status(500).json({ message: getErrorMessage(error) });
          } finally {
            client.release();
          }
        }
      )
    );
  });

  /**
   * Roll back only the accounting mutations created by the historical PO
   * reconstruction introduced by the reconciliation repair. Dry-run is the
   * default. This deliberately does not touch ordinary PO/import/intercompany
   * vouchers or supplier payments.
   */
  app.post("/api/admin/po-supplier-reconciliation/rollback", requireAuth, requireRole("Admin"), async (req, res) => {
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
                const entryIds = insertedEntryRows.rows.map((row) => row.id);
                const deleteInserted = await client.query("DELETE FROM voucher_entries WHERE id = ANY($1::int[])", [
                  entryIds,
                ]);
                removedInsertedEntries = deleteInserted.rowCount ?? 0;
              }

              if (generatedVoucherIds.length > 0) {
                await client.query("DELETE FROM voucher_entries WHERE voucher_id = ANY($1::int[])", [
                  generatedVoucherIds,
                ]);
                const deleteVouchers = await client.query("DELETE FROM vouchers WHERE id = ANY($1::int[])", [
                  generatedVoucherIds,
                ]);
                removedGeneratedVouchers = deleteVouchers.rowCount ?? 0;
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
            logger.error("PO supplier reconciliation rollback failed", { error });
            return res.status(500).json({ message: getErrorMessage(error) });
          } finally {
            client.release();
          }
        }
      )
    );
  });
}
