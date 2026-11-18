// Extracted from ./poSupplierReconciliationRoutes.ts to keep that module under the source-size cap.
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
import { editPostedVoucherWithClient, VoucherCorrectionError } from "../../services/factory/factoryVoucherCorrection";

export function registerPoSupplierReconciliationRoutesPart1(app: Express) {
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
                    // Phase 22 (C), G4: an audited open-period edit of the posted
                    // voucher (header and lines before/after in this transaction);
                    // a voucher in a closed period is left for manual review.
                    try {
                      await editPostedVoucherWithClient(
                        client,
                        {
                          companyId: expectedCompanyId,
                          voucherId: canonicalVoucherId!,
                          reason: "po-supplier-reconciliation",
                          actor: { userId: req.session.userId, username: req.session.username },
                        },
                        async () => {
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
                        }
                      );
                    } catch (editError) {
                      if (!(editError instanceof VoucherCorrectionError)) throw editError;
                      repairStatus = "manual_review";
                    }
                    if (repairStatus !== "manual_review") {
                      repairStatus = "repaired";
                      repaired += 1;
                    }
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
}
