import { getClientDate } from "../../lib/dateUtils";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import type { Express } from "express";
import { db, pool } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireRole, requireNonPOS } from "../../auth";
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
  containers,
  containerOffloads,
  purchaseOrders,
  vouchers,
  voucherEntries,
  suppliers,
  ledgerAccounts,
} from "@shared/schema";
import { eq, and, or, isNull, like } from "drizzle-orm";
import {
  classifyPoSupplierPosting,
  expectedPoSupplierPayable,
  parentImportVoucherNumberPattern,
} from "../../services/accounting/poSupplierReconciliation";

export function registerAdminPoFixRoutes(app: Express) {
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

    return runWithCompanyRequestRuntimeContext(
      { ...requestContext, authorizedCompanyIds },
      () =>
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
          results.push({ poId: po.id, poNumber: po.po_number, companyId: po.company_id, status: "missing_supplier" });
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
              const refreshedEntries = await client.query<{ id: number; voucher_id: number; credit_amount: string }>(
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
  app.post(
    "/api/admin/po-supplier-reconciliation/rollback",
    requireAuth,
    requireRole("Admin"),
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

      return runWithCompanyRequestRuntimeContext(
        { ...requestContext, authorizedCompanyIds },
        () =>
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
                    const deleteInserted = await client.query(
                      "DELETE FROM voucher_entries WHERE id = ANY($1::int[])",
                      [entryIds]
                    );
                    removedInsertedEntries = deleteInserted.rowCount ?? 0;
                  }

                  if (generatedVoucherIds.length > 0) {
                    await client.query("DELETE FROM voucher_entries WHERE voucher_id = ANY($1::int[])", [
                      generatedVoucherIds,
                    ]);
                    const deleteVouchers = await client.query(
                      "DELETE FROM vouchers WHERE id = ANY($1::int[])",
                      [generatedVoucherIds]
                    );
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
    }
  );

  app.post("/api/test-data/vouchers", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { date, debitAccountId, creditAccountId, amount, description } = req.body;

      // Validate required fields
      if (!date || !debitAccountId || !creditAccountId || !amount) {
        return res
          .status(400)
          .json({ message: "Missing required fields: date, debitAccountId, creditAccountId, amount" });
      }

      const parsedAmount = parseFloat(amount);
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        return res.status(400).json({ message: "Amount must be a positive number" });
      }

      // Verify debit account exists and belongs to current company
      const debitAccount = await storage.getLedgerAccountById(debitAccountId);
      if (!debitAccount || debitAccount.companyId !== companyId) {
        return res.status(404).json({ message: "Debit account not found or doesn't belong to current company" });
      }

      // Verify credit account exists and belongs to current company
      const creditAccount = await storage.getLedgerAccountById(creditAccountId);
      if (!creditAccount || creditAccount.companyId !== companyId) {
        return res.status(404).json({ message: "Credit account not found or doesn't belong to current company" });
      }

      // Generate a unique voucher number with TEST- prefix
      const voucherNumber = `TEST-${Date.now()}`;

      // Create the voucher as optional (excluded from calculations by default)
      const [voucher] = await db
        .insert(vouchers)
        .values({
          companyId,
          voucherNumber,
          voucherType: "Journal",
          voucherDate: date,
          description: description || `Test data entry`,
          totalAmount: parsedAmount.toFixed(2),
          optional: true, // Start as draft/optional
        })
        .returning();

      // Create debit entry
      await db.insert(voucherEntries).values({
        voucherId: voucher.id,
        ledgerAccountId: debitAccountId,
        debitAmount: parsedAmount.toFixed(2),
        creditAmount: "0",
        narration: `Test data - ${description || debitAccount.name}`,
      });

      // Create credit entry
      await db.insert(voucherEntries).values({
        voucherId: voucher.id,
        ledgerAccountId: creditAccountId,
        debitAmount: "0",
        creditAmount: parsedAmount.toFixed(2),
        narration: `Test data - ${description || creditAccount.name}`,
      });

      res.status(201).json({
        voucher,
        message: "Test entry created as optional (draft). Toggle to apply to calculations.",
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ==========================================
  // Fix Old PO Inter-Company Credits
  // ==========================================

  app.post("/api/fix-old-po-credits", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const { companyId, parentCompanyId } = req.body;

      if (!companyId) {
        return res.status(400).json({
          message: "Please select a subsidiary company to process.",
        });
      }

      if (!parentCompanyId) {
        return res.status(400).json({
          message: "Please select a parent company.",
        });
      }

      const allCompanies = await storage.getAllCompanies();

      const parentCompany = allCompanies.find((c) => c.id === parentCompanyId);

      if (!parentCompany) {
        return res.status(400).json({
          message: "Selected parent company not found.",
        });
      }

      // Find the selected subsidiary company
      const selectedCompany = allCompanies.find((c) => c.id === companyId);

      if (!selectedCompany) {
        return res.status(400).json({
          message: "Selected subsidiary company not found.",
        });
      }

      if (selectedCompany.id === parentCompany.id) {
        return res.status(400).json({
          message: "Subsidiary and parent company cannot be the same.",
        });
      }

      // Process only the selected subsidiary
      const companiesToProcess = [selectedCompany];

      let totalFixed = 0;
      let totalAmount = 0;
      const details: Array<{ company: string; poNumber: string; amount: number }> = [];

      // Process each company
      for (const company of companiesToProcess) {
        // Get or create "[Parent Company] Credit" account for this subsidiary
        const parentCreditCode = parentCompany.name.toUpperCase().replace(/\s+/g, "_") + "_CREDIT";
        const parentCreditName = parentCompany.name + " Credit";

        let creditAccount = await db
          .select()
          .from(ledgerAccounts)
          .where(
            and(
              eq(ledgerAccounts.companyId, company.id),
              eq(ledgerAccounts.code, parentCreditCode),
              isNull(ledgerAccounts.deletedAt)
            )
          )
          .limit(1);

        if (!creditAccount.length) {
          const [newAccount] = await db
            .insert(ledgerAccounts)
            .values({
              companyId: company.id,
              code: parentCreditCode,
              name: parentCreditName,
              accountType: "Liability",
              subType: "Current Liability",
              openingBalance: "0",
              openingBalanceSide: "Cr",
            })
            .returning();
          creditAccount = [newAccount];
        }

        // Get all purchase orders for this company
        const companyPOs = await db.select().from(purchaseOrders).where(eq(purchaseOrders.companyId, company.id));

        for (const po of companyPOs) {
          // Check if this PO is for an offloaded container
          const [container] = await db.select().from(containers).where(eq(containers.id, po.containerId));

          if (!container || container.status !== "OFFLOADED") {
            continue; // Skip non-offloaded containers
          }

          // Check if credit entry already exists for this PO
          // For OLD fixed POs: fix endpoint uses INTERCO-* in subsidiary and INTERCO-LUB-* in Lubumbashi
          // Check voucher patterns to prevent duplicates
          // NOTE: po.voucherId is for the import voucher (DR Purchases, CR Supplier), NOT inter-company vouchers

          // Check for existing INTERCO vouchers in subsidiary
          // Use both PO number AND container number to identify duplicates (same PO number can apply to multiple containers)
          const existingSubsidiaryVoucher = await db
            .select()
            .from(vouchers)
            .where(
              and(
                eq(vouchers.companyId, company.id),
                like(vouchers.voucherNumber, `INTERCO-%`),
                like(vouchers.description, `%${container.containerNumber}%`)
              )
            )
            .limit(1);

          if (existingSubsidiaryVoucher.length > 0) {
            continue; // Skip - already has credit entry in subsidiary for this container
          }

          // Check for existing INTERCO-PARENT vouchers in parent company for this container
          const existingParentVoucher = await db
            .select()
            .from(vouchers)
            .where(
              and(
                eq(vouchers.companyId, parentCompany.id),
                or(
                  like(vouchers.voucherNumber, `INTERCO-PARENT-%`),
                  like(vouchers.voucherNumber, `INTERCO-LUB-%`), // Legacy format
                  like(vouchers.voucherNumber, `IC-${company.id}-%`)
                ),
                like(vouchers.description, `%${container.containerNumber}%`)
              )
            )
            .limit(1);

          if (existingParentVoucher.length > 0) {
            continue; // Skip - already has credit entry in parent company for this container
          }

          // Calculate PO total: items + freight + charges
          const poItemsTotal = parseFloat(po.itemsTotal || "0");
          const poFreight = parseFloat(po.freight || "0");
          const poSurcharge = parseFloat(po.surcharge || "0");
          const poFumigation = parseFloat(po.fumigation || "0");
          const poDocumentCharges = parseFloat(po.documentCharges || "0");
          const poDiscount = parseFloat(po.discount || "0");
          const poOtherCharges = parseFloat(po.otherCharges || "0");
          const poTotal =
            poItemsTotal + poFreight + poSurcharge + poFumigation + poDocumentCharges - poDiscount + poOtherCharges;

          const poSupplier = po.supplierId
            ? await db.query.suppliers.findFirst({ where: eq(suppliers.id, po.supplierId) })
            : null;
          if (poTotal <= 0) {
            continue; // Skip zero or negative amounts
          }

          // Get offload date from container offload record
          const [offloadRecord] = await db
            .select()
            .from(containerOffloads)
            .where(eq(containerOffloads.containerId, container.id))
            .limit(1);

          const voucherDate = offloadRecord?.offloadedAt
            ? new Date(offloadRecord.offloadedAt).toISOString().split("T")[0]
            : getClientDate(req);

          // ============================================================
          // SUBSIDIARY VOUCHER - Transfer liability from Supplier to Parent Credit
          // ============================================================
          const voucherNumber = `INTERCO-${po.poNumber}-${Date.now()}`;
          const [voucher] = await db
            .insert(vouchers)
            .values({
              companyId: company.id,
              voucherNumber,
              voucherType: "Journal",
              voucherDate,
              description: `Transfer supplier liability to ${parentCompany.name} Credit - PO ${po.poNumber} - Container ${container.containerNumber}`,
              totalAmount: poTotal.toFixed(2),
            })
            .returning();

          // Debit: Supplier account (reduce payable - they got paid by parent company)
          if (po.supplierId) {
            await db.insert(voucherEntries).values({
              voucherId: voucher.id,
              supplierId: po.supplierId,
              debitAmount: poTotal.toFixed(2),
              creditAmount: "0",
              narration: `Transfer to ${parentCompany.name} Credit - PO ${po.poNumber}`,
            });
          }

          // Credit: Parent Credit account (we owe parent company, who paid the supplier)
          await db.insert(voucherEntries).values({
            voucherId: voucher.id,
            ledgerAccountId: creditAccount[0].id,
            debitAmount: "0",
            creditAmount: poTotal.toFixed(2),
            narration: `PO ${po.poNumber} - Container ${container.containerNumber} (${parentCompany.name} paid)`,
          });

          // ============================================================
          // PARENT COMPANY VOUCHER - Record receivable from subsidiary + supplier payable
          // ============================================================
          // Get or create "[Subsidiary] Credit" receivable account in parent company
          const subsidiaryCode = company.name.toUpperCase().replace(/\s+/g, "_") + "_CREDIT";
          const subsidiaryName = company.name + " Credit";

          let subsidiaryReceivableAccount = await db
            .select()
            .from(ledgerAccounts)
            .where(
              and(
                eq(ledgerAccounts.companyId, parentCompany.id),
                eq(ledgerAccounts.code, subsidiaryCode),
                isNull(ledgerAccounts.deletedAt)
              )
            )
            .limit(1);

          if (!subsidiaryReceivableAccount.length) {
            const [newAccount] = await db
              .insert(ledgerAccounts)
              .values({
                companyId: parentCompany.id,
                code: subsidiaryCode,
                name: subsidiaryName,
                accountType: "Asset",
                subType: "Current Asset",
                openingBalance: "0",
                openingBalanceSide: "Dr",
              })
              .returning();
            subsidiaryReceivableAccount = [newAccount];
          }

          // Create Journal voucher in parent company
          const parentVoucherNumber = `INTERCO-PARENT-${po.poNumber}-${Date.now()}`;
          const [parentVoucher] = await db
            .insert(vouchers)
            .values({
              companyId: parentCompany.id,
              voucherNumber: parentVoucherNumber,
              voucherType: "Journal",
              voucherDate,
              description: `${container.containerNumber} ${poSupplier?.legalName || "Unknown Supplier"}`,
              totalAmount: poTotal.toFixed(2),
            })
            .returning();

          // DR [Subsidiary] Credit (they owe us)
          await db.insert(voucherEntries).values({
            voucherId: parentVoucher.id,
            ledgerAccountId: subsidiaryReceivableAccount[0].id,
            debitAmount: poTotal.toFixed(2),
            creditAmount: "0",
            narration: `PO ${po.poNumber} - ${company.name} owes us`,
          });

          // CR Supplier (we owe supplier)
          if (po.supplierId) {
            await db.insert(voucherEntries).values({
              voucherId: parentVoucher.id,
              supplierId: po.supplierId,
              debitAmount: "0",
              creditAmount: poTotal.toFixed(2),
              narration: `PO ${po.poNumber} - Supplier payment`,
            });
          }

          totalFixed++;
          totalAmount += poTotal;
          details.push({
            company: company.name,
            poNumber: po.poNumber,
            amount: poTotal,
          });
        }
      }

      res.json({
        message: `Fixed ${totalFixed} POs for ${selectedCompany.name} (parent: ${parentCompany.name})`,
        fixed: totalFixed,
        totalAmount: totalAmount.toFixed(2),
        details,
        processedCompanies: 1,
      });
    } catch (error: unknown) {
      logger.error("Fix old PO credits error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ==========================================
  // Fix Parent Company POs Missing Supplier Entries
  // ==========================================

  app.post("/api/fix-parent-po-supplier-entries", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const parentCompanyId = await storage.getParentCompanyId();

      if (!parentCompanyId) {
        return res.status(400).json({
          message: "No parent company configured. Please set the parent company in Settings first.",
        });
      }

      // Get the parent company
      const parentCompany = await storage.getCompanyById(parentCompanyId);
      if (!parentCompany) {
        return res.status(404).json({ message: "Parent company not found" });
      }

      // Find all POs in the parent company
      const allPOs = await db.select().from(purchaseOrders).where(eq(purchaseOrders.companyId, parentCompanyId));

      let fixed = 0;
      let skipped = 0;
      let totalAmount = 0;
      const details = [];

      for (const po of allPOs) {
        if (!po.voucherId || !po.supplierId) {
          skipped++;
          continue;
        }

        // Calculate PO total
        const itemsTotal = parseFloat(po.itemsTotal || "0");
        const freight = parseFloat(po.freight || "0");
        const surcharge = parseFloat(po.surcharge || "0");
        const fumigation = parseFloat(po.fumigation || "0");
        const documentCharges = parseFloat(po.documentCharges || "0");
        const discount = parseFloat(po.discount || "0");
        const otherCharges = parseFloat(po.otherCharges || "0");
        const poTotal = itemsTotal + freight + surcharge + fumigation + documentCharges - discount + otherCharges;

        const _poSupplier = po.supplierId
          ? await db.query.suppliers.findFirst({ where: eq(suppliers.id, po.supplierId) })
          : null;
        if (poTotal <= 0) {
          skipped++;
          continue;
        }

        // Get or create Purchases account
        let purchasesAccount = await storage.getLedgerAccountByName("Purchases", parentCompanyId);
        if (!purchasesAccount) {
          purchasesAccount = await storage.getLedgerAccountByCode("PURCHASES", parentCompanyId);
        }
        if (!purchasesAccount) {
          purchasesAccount = await storage.createLedgerAccount({
            companyId: parentCompanyId,
            name: "Purchases",
            code: "PURCHASES",
            accountType: "Expense",
            subType: "Direct Expense",
          });
        }

        // Check if voucher already has purchase entry
        const existingPurchaseEntry = await db
          .select()
          .from(voucherEntries)
          .where(
            and(eq(voucherEntries.voucherId, po.voucherId), eq(voucherEntries.ledgerAccountId, purchasesAccount.id))
          )
          .limit(1);

        // Check if this voucher already has a supplier entry
        const existingSupplierEntry = await db
          .select()
          .from(voucherEntries)
          .where(and(eq(voucherEntries.voucherId, po.voucherId), eq(voucherEntries.supplierId, po.supplierId)))
          .limit(1);

        // Skip if both entries already exist
        if (existingPurchaseEntry.length > 0 && existingSupplierEntry.length > 0) {
          skipped++;
          continue;
        }

        let fixedThisPO = false;

        // Add DR Purchases entry if missing
        if (existingPurchaseEntry.length === 0) {
          await db.insert(voucherEntries).values({
            voucherId: po.voucherId,
            ledgerAccountId: purchasesAccount.id,
            debitAmount: poTotal.toFixed(2),
            creditAmount: "0",
            narration: `PO ${po.poNumber} - Fix missing entry`,
          });
          fixedThisPO = true;
        }

        // Add CR Supplier entry if missing
        if (existingSupplierEntry.length === 0) {
          await db.insert(voucherEntries).values({
            voucherId: po.voucherId,
            supplierId: po.supplierId,
            debitAmount: "0",
            creditAmount: poTotal.toFixed(2),
            narration: `PO ${po.poNumber} - Fix missing supplier entry`,
          });
          fixedThisPO = true;
        }

        if (fixedThisPO) {
          fixed++;
          totalAmount += poTotal;
          details.push({
            poNumber: po.poNumber,
            amount: poTotal.toFixed(2),
            fixedPurchases: existingPurchaseEntry.length === 0,
            fixedSupplier: existingSupplierEntry.length === 0,
          });
        } else {
          skipped++;
        }
      }

      res.json({
        message: `Fixed ${fixed} POs in ${parentCompany.name}. Skipped ${skipped} (already had entries or invalid).`,
        fixed,
        skipped,
        totalAmount: totalAmount.toFixed(2),
        details,
      });
    } catch (error: unknown) {
      logger.error("Fix parent PO supplier entries error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ==========================================
  // Reverse Fix Old PO Inter-Company Credits
  // ==========================================

  app.post("/api/reverse-po-credits", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const { companyId, parentCompanyId } = req.body;

      if (!companyId) {
        return res.status(400).json({
          message: "Please select a subsidiary company to reverse.",
        });
      }

      if (!parentCompanyId) {
        return res.status(400).json({
          message: "Please select a parent company.",
        });
      }

      const allCompanies = await storage.getAllCompanies();
      const company = allCompanies.find((c) => c.id === companyId);
      const parentCompany = allCompanies.find((c) => c.id === parentCompanyId);

      if (!company) {
        return res.status(400).json({ message: "Subsidiary company not found." });
      }

      if (!parentCompany) {
        return res.status(400).json({
          message: "Parent company not found.",
        });
      }

      if (company.id === parentCompany.id) {
        return res.status(400).json({
          message: "Subsidiary and parent company cannot be the same.",
        });
      }

      // Process only the selected subsidiary
      const targetCompany = company;

      let totalReversed = 0;
      const details: Array<{ company: string; voucherNumber: string; amount: string }> = [];

      // Delete INTERCO vouchers in this subsidiary company
      const companyIntercoVouchers = await db
        .select()
        .from(vouchers)
        .where(and(eq(vouchers.companyId, targetCompany.id), like(vouchers.voucherNumber, "INTERCO-%")));

      for (const v of companyIntercoVouchers) {
        // Delete voucher entries first
        await db.delete(voucherEntries).where(eq(voucherEntries.voucherId, v.id));
        // Delete voucher
        await db.delete(vouchers).where(eq(vouchers.id, v.id));
        totalReversed++;
        details.push({ company: targetCompany.name, voucherNumber: v.voucherNumber, amount: v.totalAmount || "0" });
      }

      // Also delete corresponding INTERCO-PARENT vouchers in parent company for this subsidiary
      const parentIntercoVouchers = await db
        .select()
        .from(vouchers)
        .where(
          and(
            eq(vouchers.companyId, parentCompany.id),
            or(
              like(vouchers.voucherNumber, "INTERCO-PARENT-%"),
              like(vouchers.voucherNumber, "INTERCO-LUB-%") // Also match old format
            ),
            like(vouchers.description, `%${targetCompany.name}%`)
          )
        );

      for (const v of parentIntercoVouchers) {
        await db.delete(voucherEntries).where(eq(voucherEntries.voucherId, v.id));
        await db.delete(vouchers).where(eq(vouchers.id, v.id));
        totalReversed++;
        details.push({
          company: `${parentCompany.name} (for ${targetCompany.name})`,
          voucherNumber: v.voucherNumber,
          amount: v.totalAmount || "0",
        });
      }

      res.json({
        message: `Reversed ${totalReversed} inter-company vouchers for ${company.name} (parent: ${parentCompany.name})`,
        reversed: totalReversed,
        details,
        processedCompanies: 1,
      });
    } catch (error: unknown) {
      logger.error("Reverse PO credits error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ==========================================
  // Reset Company Data (Admin only)
  // Deletes Payment/Receipt/Journal vouchers for selected company
  // ==========================================
}
