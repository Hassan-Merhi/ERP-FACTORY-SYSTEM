/**
 * SP migration routes - Read-only historical sales copy, container migration and profit opening balances.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { logger } from "../../lib/logger";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { sql } from "drizzle-orm";
import {
  pn,
  getCompanyRow,
  logRun,
  trackRow,
  requireCompletedMigrationAction,
  ensureTargetStockItems,
} from "./_helpers";

/** Account-mapping columns read from ledger_accounts during an SP migration run. */
type SpLedgerAccountRow = { id: number; account_type: string; sub_type: string | null };

export function registerSpMigrationSalesRoutes(app: Express) {
  // ── Historical sales — TRUE read-only copy ──────────────────────────────
  // POST /api/sp/migration/gc-sales-readonly
  app.post(
    "/api/sp/migration/gc-sales-readonly",
    requireAuth,
    requireRole("Developer"),
    async (req: Request, res: Response) => {
      const { sourceCompanyId, targetCompanyId, companyNameConfirm, confirmation } = req.body ?? {};
      if (confirmation !== "MIGRATE") {
        return res.status(400).json({ message: 'Requires confirmation = "MIGRATE"' });
      }
      const sourceId = parseInt(String(sourceCompanyId ?? ""), 10);
      const targetId = parseInt(String(targetCompanyId ?? ""), 10);
      if (!sourceId || !targetId)
        return res.status(400).json({ message: "sourceCompanyId and targetCompanyId required" });

      const sourceComp = await getCompanyRow(sourceId);
      const targetComp = await getCompanyRow(targetId);
      if (!sourceComp) return res.status(404).json({ message: "Source company not found" });
      if (!targetComp) return res.status(404).json({ message: "Target company not found" });
      if (sourceComp.company_type !== "erp")
        return res.status(400).json({ message: "Source company must be type 'erp'" });
      if (targetComp.company_type !== "supplier_partner")
        return res.status(400).json({ message: "Target company must be type 'supplier_partner'" });
      if (!companyNameConfirm || companyNameConfirm.trim() !== sourceComp.name) {
        return res.status(400).json({ message: `Company name confirmation must match exactly: "${sourceComp.name}"` });
      }
      const depError = await requireCompletedMigrationAction(sourceId, targetId, "gc_sales_readonly");
      if (depError) return res.status(409).json({ message: depError });

      const runId = await logRun(
        sourceId,
        targetId,
        "gc_sales_readonly",
        "running",
        0,
        null,
        `User: ${req.session?.userId ?? "unknown"} | Source: ${sourceComp.name} | Target: ${targetComp.name}`
      );

      let rowsCreated = 0;
      const summary: string[] = [];
      try {
        // Reuse the same account-mapping strategy as gc-rehearsal
        const ERP_TO_SP_SUBTYPE: Record<string, string> = {
          "Direct Income": "sp_sales",
          "Direct Expense": "sp_cogs",
          "Indirect Expense": "sp_shared_charges",
          hadi_sp_intercompany: "sp_hadi_intercompany",
        };
        const sourceAccts = (
          await db.execute<SpLedgerAccountRow>(
            sql`SELECT id, account_type, sub_type FROM ledger_accounts WHERE company_id = ${sourceId} AND deleted_at IS NULL`
          )
        ).rows;
        const targetAccts = (
          await db.execute<SpLedgerAccountRow>(
            sql`SELECT id, account_type, sub_type FROM ledger_accounts WHERE company_id = ${targetId} AND deleted_at IS NULL`
          )
        ).rows;
        const targetBySubType = new Map<string, number>();
        for (const ta of targetAccts) if (ta.sub_type) targetBySubType.set(ta.sub_type, pn(ta.id));

        let suspenseAccountId: number;
        const existingSuspense = (
          await db.execute(
            sql`SELECT id FROM ledger_accounts WHERE company_id = ${targetId} AND sub_type = 'gc_mig_suspense' AND deleted_at IS NULL LIMIT 1`
          )
        ).rows[0];
        if (existingSuspense) {
          suspenseAccountId = pn(existingSuspense.id);
        } else {
          const [suspRow] = (
            await db.execute(sql`
            INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, active, is_hidden)
            VALUES (${targetId}, 'GC-SUSP', 'Migration Suspense', 'Equity', 'gc_mig_suspense', true, true)
            RETURNING id
          `)
          ).rows;
          suspenseAccountId = pn(suspRow.id);
          await trackRow(runId, "ledger_accounts", suspenseAccountId);
          rowsCreated++;
        }

        const accountMap = new Map<number, number | null>();
        for (const sa of sourceAccts) {
          const srcId = pn(sa.id);
          if (sa.sub_type && targetBySubType.has(sa.sub_type)) accountMap.set(srcId, targetBySubType.get(sa.sub_type)!);
          else if (
            sa.account_type &&
            ERP_TO_SP_SUBTYPE[sa.account_type] &&
            targetBySubType.has(ERP_TO_SP_SUBTYPE[sa.account_type])
          )
            accountMap.set(srcId, targetBySubType.get(ERP_TO_SP_SUBTYPE[sa.account_type])!);
          else accountMap.set(srcId, suspenseAccountId);
        }

        const saleVouchers = (
          await db.execute(sql`
          SELECT id, voucher_number, voucher_type, voucher_date, description, total_amount, currency, exchange_rate
          FROM vouchers
          WHERE company_id = ${sourceId} AND voucher_type IN ('Sales', 'Sale') AND deleted_at IS NULL
          ORDER BY voucher_date ASC, id ASC
        `)
        ).rows;

        // Stock item mapping produced by Step 4 (Stock Master) — required to translate
        // source sale-item stock_item_id references into the target company's stock items.
        const stockItemLinkRows = (
          await db.execute(sql`
          SELECT sml.source_id, sml.target_id
          FROM sp_migration_source_links sml
          JOIN sp_migration_rehearsal_runs r ON r.id = sml.run_id
          WHERE r.target_company_id = ${targetId} AND r.source_company_id = ${sourceId}
            AND sml.source_table = 'stock_items' AND sml.target_table = 'stock_items'
        `)
        ).rows;
        const stockItemMap = new Map<number, number>();
        for (const l of stockItemLinkRows) stockItemMap.set(pn(l.source_id), pn(l.target_id));

        let vouchersCreated = 0,
          vouchersSkipped = 0,
          entriesCreated = 0,
          itemRowsCreated = 0,
          vouchersMissingItems = 0;
        for (const v of saleVouchers) {
          const newVoucherNumber = ("MIG-GC-" + v.voucher_number).substring(0, 100);
          const alreadyMig = (
            await db.execute(
              sql`SELECT id FROM vouchers WHERE voucher_number = ${newVoucherNumber} AND company_id = ${targetId} LIMIT 1`
            )
          ).rows[0];
          if (alreadyMig) {
            vouchersSkipped++;
            continue;
          }

          // Header, sale items and entries commit together; run tracking is recorded after commit.
          const afterCommit: Array<() => Promise<void>> = [];
          await db.transaction(async (tx) => {
            const [vRow] = (
              await tx.execute(sql`
            INSERT INTO vouchers
              (company_id, voucher_number, voucher_type, voucher_date, description, total_amount, currency, exchange_rate, source_module)
            VALUES
              (${targetId}, ${newVoucherNumber}, ${v.voucher_type}, ${v.voucher_date},
               ${v.description ?? "Migrated (read-only) from GC-LSHI ERP"},
               ${v.total_amount}, ${v.currency ?? "USD"}, ${v.exchange_rate ?? null}, 'SP_MIGRATION_READONLY')
            RETURNING id
          `)
            ).rows;
            const newVoucherId = pn(vRow.id);
            afterCommit.push(() => trackRow(runId, "vouchers", newVoucherId));
            rowsCreated++;
            vouchersCreated++;

            await tx.execute(sql`
            INSERT INTO sp_migration_source_links (run_id, source_table, source_id, target_table, target_id)
            VALUES (${runId}, 'vouchers', ${pn(v.id)}, 'vouchers', ${newVoucherId})
          `);

            // Copy the original sale-item rows so migrated vouchers show real item details
            // (not just the accounting entries) — display/history only, never touches stock.
            const sourceSaleItems = (
              await tx.execute(sql`
            SELECT stock_item_id, quantity, selling_price, cost_price, total_sales, total_cost, profit, configured_price
            FROM sales_items WHERE voucher_id = ${v.id}
          `)
            ).rows;
            if (!sourceSaleItems.length) {
              vouchersMissingItems++;
              summary.push(
                `Voucher ${v.voucher_number} has no source sale item rows; accounting-only voucher migrated.`
              );
            } else {
              for (const si of sourceSaleItems) {
                const targetStockItemId = stockItemMap.get(pn(si.stock_item_id));
                if (!targetStockItemId) {
                  summary.push(
                    `Voucher ${v.voucher_number}: sale item for source stock_item_id=${si.stock_item_id} has no target stock item mapping — skipped (run Stock Master first).`
                  );
                  continue;
                }
                const [siRow] = (
                  await tx.execute(sql`
                INSERT INTO sales_items
                  (voucher_id, stock_item_id, quantity, selling_price, cost_price, total_sales, total_cost, profit, configured_price)
                VALUES
                  (${newVoucherId}, ${targetStockItemId}, ${si.quantity}, ${si.selling_price}, ${si.cost_price},
                   ${si.total_sales}, ${si.total_cost}, ${si.profit ?? "0"}, ${si.configured_price ?? null})
                RETURNING id
              `)
                ).rows;
                afterCommit.push(() => trackRow(runId, "sales_items", pn(siRow.id)));
                itemRowsCreated++;
                rowsCreated++;
              }
            }

            const entries = (
              await tx.execute(
                sql`SELECT ledger_account_id, debit_amount, credit_amount, narration FROM voucher_entries WHERE voucher_id = ${v.id}`
              )
            ).rows;
            for (const e of entries) {
              const srcAcctId = e.ledger_account_id ? pn(e.ledger_account_id) : null;
              const mappedAcctId = srcAcctId !== null ? (accountMap.get(srcAcctId) ?? suspenseAccountId) : null;
              const [eRow] = (
                await tx.execute(sql`
              INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
              VALUES (${newVoucherId}, ${mappedAcctId}, ${e.debit_amount ?? "0"}, ${e.credit_amount ?? "0"}, ${e.narration ?? null})
              RETURNING id
            `)
              ).rows;
              afterCommit.push(() => trackRow(runId, "voucher_entries", pn(eRow.id)));
              entriesCreated++;
              rowsCreated++;
            }
          });
          for (const record of afterCommit) await record();
        }

        summary.push(
          `Vouchers: ${vouchersCreated} created (read-only), ${vouchersSkipped} skipped, ${entriesCreated} entries, ${itemRowsCreated} sale item rows copied`
        );
        if (vouchersMissingItems) summary.push(`${vouchersMissingItems} voucher(s) had no source sale item rows.`);

        await db.execute(sql`
          UPDATE sp_migration_rehearsal_runs SET status = 'completed', rows_created = ${rowsCreated}, completed_at = now() WHERE id = ${runId}
        `);

        return res.json({
          success: true,
          runId,
          rowsCreated,
          summary,
          reconciliation: { vouchersCreated, vouchersSkipped, entriesCreated, itemRowsCreated, vouchersMissingItems },
          warnings: [
            "These vouchers are marked read-only (sourceModule = SP_MIGRATION_READONLY, prefix MIG-GC-) and never move stock.",
            "Account mapping used account type matching — verify entries routed to Migration Suspense.",
          ],
        });
      } catch (err: unknown) {
        await db
          .execute(
            sql`UPDATE sp_migration_rehearsal_runs SET status = 'failed', error_message = ${getErrorMessage(err)}, completed_at = now() WHERE id = ${runId}`
          )
          .catch(() => {});
        logger.error("[SP Migration] gc-sales-readonly error:", {
          sourceCompanyId: sourceId,
          targetCompanyId: targetId,
          runId,
          error: getErrorMessage(err),
        });
        return res.status(500).json({
          message: `Historical sales migration failed: ${getErrorMessage(err) || "Unknown error"}`,
          runId,
        });
      }
    }
  );

  // ── Container migration into SP ─────────────────────────────────────────
  // POST /api/sp/migration/gc-containers
  // Creates sp_containers/sp_container_lines from ERP containers/purchase_orders/po_line_items.
  // Does NOT re-create stock movements for offloaded containers — that stock is
  // already covered by the stock-opening step; only OPEN (OTW) containers get an
  // OTW clearing voucher since their stock isn't yet in source inventory either.
  app.post(
    "/api/sp/migration/gc-containers",
    requireAuth,
    requireRole("Developer"),
    async (req: Request, res: Response) => {
      const { sourceCompanyId, targetCompanyId, companyNameConfirm, confirmation } = req.body ?? {};
      if (confirmation !== "MIGRATE") {
        return res.status(400).json({ message: 'Requires confirmation = "MIGRATE"' });
      }
      const sourceId = parseInt(String(sourceCompanyId ?? ""), 10);
      const targetId = parseInt(String(targetCompanyId ?? ""), 10);
      if (!sourceId || !targetId)
        return res.status(400).json({ message: "sourceCompanyId and targetCompanyId required" });

      const sourceComp = await getCompanyRow(sourceId);
      const targetComp = await getCompanyRow(targetId);
      if (!sourceComp) return res.status(404).json({ message: "Source company not found" });
      if (!targetComp) return res.status(404).json({ message: "Target company not found" });
      if (sourceComp.company_type !== "erp")
        return res.status(400).json({ message: "Source company must be type 'erp'" });
      if (targetComp.company_type !== "supplier_partner")
        return res.status(400).json({ message: "Target company must be type 'supplier_partner'" });
      if (!companyNameConfirm || companyNameConfirm.trim() !== sourceComp.name) {
        return res.status(400).json({ message: `Company name confirmation must match exactly: "${sourceComp.name}"` });
      }
      const depError = await requireCompletedMigrationAction(sourceId, targetId, "gc_containers");
      if (depError) return res.status(409).json({ message: depError });

      const runId = await logRun(
        sourceId,
        targetId,
        "gc_containers",
        "running",
        0,
        null,
        `User: ${req.session?.userId ?? "unknown"} | Source: ${sourceComp.name} | Target: ${targetComp.name}`
      );

      let rowsCreated = 0;
      const summary: string[] = [];
      const chargeWarnings: string[] = [];
      let otwVouchersCreated = 0,
        otwVouchersSkipped = 0;
      try {
        const { map: stockItemMap } = await ensureTargetStockItems(sourceId, targetId, runId);

        // OTW accounts must exist before we can post open-container vouchers.
        const otwAcctRows = (
          await db.execute(sql`
        SELECT sub_type, id FROM ledger_accounts
        WHERE company_id = ${targetId} AND deleted_at IS NULL AND sub_type IN ('sp_goods_otw', 'sp_otw_clearing')
      `)
        ).rows;
        const otwBySubType = new Map(otwAcctRows.map((r) => [r.sub_type, pn(r.id)]));
        const otwAssetAcctId = otwBySubType.get("sp_goods_otw");
        const otwClearingAcctId = otwBySubType.get("sp_otw_clearing");

        const containerRows = (
          await db.execute(sql`
        SELECT id, container_number, supplier_id, status, import_date, items_total, charges_total, grand_total
        FROM containers WHERE company_id = ${sourceId}
        ORDER BY import_date ASC, id ASC
      `)
        ).rows;

        let containersCreated = 0,
          containersSkipped = 0,
          linesCreated = 0;

        for (const c of containerRows) {
          const srcContainerId = pn(c.id);
          const alreadyLinked = (
            await db.execute(sql`
          SELECT target_id FROM sp_migration_source_links
          WHERE source_table = 'containers' AND source_id = ${srcContainerId} AND target_table = 'sp_containers' LIMIT 1
        `)
          ).rows[0];
          if (alreadyLinked) {
            containersSkipped++;
            continue;
          }

          // Supplier name lookup (best-effort — supplier match by name in target is a manual step, so supplierId stays null)
          const supplierRow = (
            await db.execute(sql`SELECT legal_name FROM suppliers WHERE id = ${pn(c.supplier_id)} LIMIT 1`)
          ).rows[0];
          const supplierName = supplierRow?.legal_name ?? "Unknown Supplier (GC migration)";

          const poRow = (
            await db.execute(sql`
          SELECT id, po_number, freight FROM purchase_orders WHERE container_id = ${srcContainerId} LIMIT 1
        `)
          ).rows[0];

          const status = c.status === "OTW" || c.status === "Open" ? "open" : "offloaded";

          const [contRow] = (
            await db.execute(sql`
          INSERT INTO sp_containers
            (company_id, supplier_id, supplier_name, container_number, invoice_number, invoice_date,
             invoice_total_usd, freight_estimate_usd, status, notes)
          VALUES
            (${targetId}, NULL, ${supplierName}, ${c.container_number}, ${poRow?.po_number ?? c.container_number},
             ${c.import_date}, ${c.items_total ?? "0"}, ${poRow?.freight ?? "0"}, ${status},
             ${"Migrated from GC-LSHI ERP container #" + c.container_number})
          RETURNING id
        `)
          ).rows;
          const newContainerId = pn(contRow.id);
          await trackRow(runId, "sp_containers", newContainerId);
          await db.execute(sql`
          INSERT INTO sp_migration_source_links (run_id, source_table, source_id, target_table, target_id)
          VALUES (${runId}, 'containers', ${srcContainerId}, 'sp_containers', ${newContainerId})
        `);
          rowsCreated++;
          containersCreated++;

          // Open/OTW containers have goods in transit that are not yet in any inventory
          // (source or target), so unlike offloaded containers their value isn't covered
          // by the stock-opening step. Post a Dr Goods-OTW / Cr OTW Clearing voucher so the
          // asset shows up on the SP books, matching the container's invoice total.
          if (status === "open") {
            const otwAmount = parseFloat(String(c.items_total ?? c.grand_total ?? "0")) || 0;
            if (!otwAssetAcctId || !otwClearingAcctId) {
              chargeWarnings.push(
                `Container ${c.container_number}: is OTW but Goods-OTW/OTW-Clearing accounts are missing in target — no accounting voucher posted. Run account creation first.`
              );
            } else if (otwAmount <= 0) {
              chargeWarnings.push(
                `Container ${c.container_number}: is OTW but has no positive invoice total — skipped OTW voucher.`
              );
              otwVouchersSkipped++;
            } else {
              const otwVoucherNumber = `GC-OTW-${targetId}-${srcContainerId}`;
              const existingOtwV = (
                await db.execute(
                  sql`SELECT id FROM vouchers WHERE company_id = ${targetId} AND voucher_number = ${otwVoucherNumber} LIMIT 1`
                )
              ).rows[0];
              if (existingOtwV) {
                otwVouchersSkipped++;
              } else {
                const afterCommit: Array<() => Promise<void>> = [];
                await db.transaction(async (tx) => {
                  const [otwVRow] = (
                    await tx.execute(sql`
                INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, description, total_amount, currency, source_module)
                VALUES (${targetId}, ${otwVoucherNumber}, 'Journal', ${c.import_date ?? new Date().toISOString().split("T")[0]},
                        ${"GC Migration — Goods-OTW opening for container " + c.container_number},
                        ${otwAmount.toFixed(2)}, 'USD', 'SP_MIGRATION')
                RETURNING id
              `)
                  ).rows;
                  const otwVoucherId = pn(otwVRow.id);
                  afterCommit.push(() => trackRow(runId, "vouchers", otwVoucherId));

                  const [otwDrEntry] = (
                    await tx.execute(sql`
                INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
                VALUES (${otwVoucherId}, ${otwAssetAcctId}, ${otwAmount.toFixed(2)}, '0.00', ${"Goods OTW — container " + c.container_number})
                RETURNING id
              `)
                  ).rows;
                  afterCommit.push(() => trackRow(runId, "voucher_entries", pn(otwDrEntry.id)));

                  const [otwCrEntry] = (
                    await tx.execute(sql`
                INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
                VALUES (${otwVoucherId}, ${otwClearingAcctId}, '0.00', ${otwAmount.toFixed(2)}, ${"Goods OTW clearing — container " + c.container_number})
                RETURNING id
              `)
                  ).rows;
                  afterCommit.push(() => trackRow(runId, "voucher_entries", pn(otwCrEntry.id)));
                });
                for (const record of afterCommit) await record();

                rowsCreated += 3;
                otwVouchersCreated++;
              }
            }
          }

          if (poRow) {
            const lineItems = (
              await db.execute(sql`
            SELECT stock_item_id, item_name, quantity, rate FROM po_line_items WHERE po_id = ${pn(poRow.id)}
          `)
            ).rows;
            for (const li of lineItems) {
              const srcStockItemId = li.stock_item_id ? pn(li.stock_item_id) : null;
              const targetStockItemId = srcStockItemId ? (stockItemMap.get(srcStockItemId) ?? null) : null;
              if (srcStockItemId && !targetStockItemId) {
                chargeWarnings.push(
                  `Container ${c.container_number}: line "${li.item_name}" has no mapped target stock item.`
                );
              }
              const [lineRow] = (
                await db.execute(sql`
              INSERT INTO sp_container_lines (container_id, company_id, article_code, description, qty, unit_rate_usd, stock_item_id)
              VALUES (${newContainerId}, ${targetId}, ${li.item_name}, ${li.item_name}, ${li.quantity}, ${li.rate}, ${targetStockItemId})
              RETURNING id
            `)
              ).rows;
              await trackRow(runId, "sp_container_lines", pn(lineRow.id));
              linesCreated++;
              rowsCreated++;
            }
          } else {
            chargeWarnings.push(
              `Container ${c.container_number}: no purchase order found — line items were not migrated.`
            );
          }

          // Charges beyond freight (duty, surcharge, fumigation, etc.) are best-effort noted, not posted —
          // they typically require account-specific mapping that must be reviewed manually.
          if (poRow) {
            chargeWarnings.push(
              `Container ${c.container_number}: only freight was carried over — duty/surcharge/fumigation/other charges must be reviewed and entered manually in SP.`
            );
          }
        }

        summary.push(
          `Containers: ${containersCreated} created, ${containersSkipped} skipped (already migrated), ${linesCreated} line(s) created`
        );
        summary.push(
          `OTW accounting: ${otwVouchersCreated} voucher(s) posted, ${otwVouchersSkipped} skipped (already posted or zero value)`
        );

        await db.execute(sql`
        UPDATE sp_migration_rehearsal_runs SET status = 'completed', rows_created = ${rowsCreated}, completed_at = now() WHERE id = ${runId}
      `);

        return res.json({
          success: true,
          runId,
          rowsCreated,
          summary,
          warnings: [
            ...Array.from(new Set(chargeWarnings)),
            "Supplier linkage was not auto-matched — set supplierId on migrated SP containers manually if needed.",
            "Offloaded containers' stock quantities are already covered by the stock-opening step; this step only migrates container/line records for history.",
          ],
        });
      } catch (err: unknown) {
        await db
          .execute(
            sql`UPDATE sp_migration_rehearsal_runs SET status = 'failed', error_message = ${getErrorMessage(err)}, completed_at = now() WHERE id = ${runId}`
          )
          .catch(() => {});
        logger.error("[SP Migration] gc-containers error:", {
          sourceCompanyId: sourceId,
          targetCompanyId: targetId,
          runId,
          error: getErrorMessage(err),
        });
        return res.status(500).json({
          message: `Container migration failed: ${getErrorMessage(err) || "Unknown error"}`,
          runId,
        });
      }
    }
  );

  // ── Profit-share opening balance ────────────────────────────────────────
  // POST /api/sp/migration/gc-profit-opening
  // Posts: Dr GC-PROFCLR (accumulated profit) / Cr GC-OURPFT (our share) + Cr GC-SUPPFT (supplier share)
  app.post(
    "/api/sp/migration/gc-profit-opening",
    requireAuth,
    requireRole("Developer"),
    async (req: Request, res: Response) => {
      try {
        const {
          targetCompanyId,
          cutoffDate,
          accumulatedProfit,
          ourSplitPct,
          ourShareAmount: ourShareAmountRaw,
          supplierShareAmount: supplierShareAmountRaw,
          notes: profitNotes,
        } = req.body ?? {};
        const targetId = parseInt(String(targetCompanyId ?? ""), 10);
        const profit = parseFloat(accumulatedProfit);
        const ourPct =
          ourSplitPct !== undefined && ourSplitPct !== null && ourSplitPct !== "" ? parseFloat(ourSplitPct) : 50;

        // Manual split amounts take priority over the percentage when both are provided.
        const manualOurShare =
          ourShareAmountRaw !== undefined && ourShareAmountRaw !== null && ourShareAmountRaw !== ""
            ? parseFloat(ourShareAmountRaw)
            : null;
        const manualSupplierShare =
          supplierShareAmountRaw !== undefined && supplierShareAmountRaw !== null && supplierShareAmountRaw !== ""
            ? parseFloat(supplierShareAmountRaw)
            : null;
        const usingManualSplit = manualOurShare !== null && manualSupplierShare !== null;

        if (!targetId) return res.status(400).json({ message: "targetCompanyId is required" });
        if (!cutoffDate) return res.status(400).json({ message: "cutoffDate is required" });
        if (isNaN(profit) || profit < 0)
          return res.status(400).json({ message: "accumulatedProfit must be a non-negative number" });
        if (!usingManualSplit && (isNaN(ourPct) || ourPct < 0 || ourPct > 100))
          return res.status(400).json({ message: "ourSplitPct must be between 0 and 100" });
        if (usingManualSplit) {
          if (isNaN(manualOurShare!) || manualOurShare! < 0)
            return res.status(400).json({ message: "ourShareAmount must be a non-negative number" });
          if (isNaN(manualSupplierShare!) || manualSupplierShare! < 0)
            return res.status(400).json({ message: "supplierShareAmount must be a non-negative number" });
          if (Math.abs(manualOurShare! + manualSupplierShare! - profit) > 0.01) {
            return res.status(400).json({
              message: `Our share + supplier share (${(manualOurShare! + manualSupplierShare!).toFixed(2)}) must equal accumulated profit (${profit.toFixed(2)}).`,
            });
          }
        }

        const targetComp = await getCompanyRow(targetId);
        if (!targetComp) return res.status(404).json({ message: "Target company not found" });
        if (targetComp.company_type !== "supplier_partner")
          return res.status(400).json({ message: "Target must be a supplier_partner company" });

        const acctRows = (
          await db.execute(sql`
          SELECT sub_type, id FROM ledger_accounts
          WHERE company_id = ${targetId} AND deleted_at IS NULL
            AND sub_type IN ('gc_our_profit_share', 'gc_supplier_profit_share', 'gc_accumulated_profit_clearing')
        `)
        ).rows;
        const bySubType = new Map(acctRows.map((r) => [r.sub_type, pn(r.id)]));
        const ourAcctId = bySubType.get("gc_our_profit_share");
        const supAcctId = bySubType.get("gc_supplier_profit_share");
        const clrAcctId = bySubType.get("gc_accumulated_profit_clearing");
        if (!ourAcctId || !supAcctId || !clrAcctId) {
          return res.status(400).json({
            message: "GC profit-share accounts not found in target company. Run the account creation step first.",
          });
        }

        const runId = await logRun(
          targetId,
          targetId,
          "gc_profit_opening",
          "running",
          0,
          null,
          `User: ${req.session?.userId ?? "unknown"} | Target: ${targetComp.name}`
        );

        const ourShare = usingManualSplit
          ? Math.round(manualOurShare! * 100) / 100
          : Math.round(profit * (ourPct / 100) * 100) / 100;
        const supplierShare = usingManualSplit
          ? Math.round(manualSupplierShare! * 100) / 100
          : Math.round((profit - ourShare) * 100) / 100;
        const splitDescLabel = usingManualSplit ? "manual split" : `${ourPct}% / ${100 - ourPct}% split`;

        // Deterministic voucher number (no timestamp) so re-running for the same
        // target + cutoff date is idempotent instead of creating a duplicate journal.
        const voucherNumber = `GC-PROFIT-OPN-${targetId}-${cutoffDate}`;
        const existing = (
          await db.execute(
            sql`SELECT id FROM vouchers WHERE company_id = ${targetId} AND voucher_number = ${voucherNumber} LIMIT 1`
          )
        ).rows[0];
        if (existing) {
          await db
            .execute(
              sql`UPDATE sp_migration_rehearsal_runs SET status = 'failed', error_message = 'Duplicate — already posted', completed_at = now() WHERE id = ${runId}`
            )
            .catch(() => {});
          return res.status(409).json({
            message: `A profit-share opening balance for ${cutoffDate} has already been posted (voucher ${voucherNumber}). Roll it back first if you need to re-post with different figures.`,
            voucherId: pn(existing.id),
            voucherNumber,
          });
        }

        const afterCommit: Array<() => Promise<void>> = [];
        const voucherId = await db.transaction(async (tx) => {
          const [vRow] = (
            await tx.execute(sql`
          INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, description, total_amount, currency, source_module)
          VALUES (${targetId}, ${voucherNumber}, 'Journal', ${cutoffDate},
                  ${`GC accumulated profit-share opening balance as of ${cutoffDate} (${splitDescLabel})${profitNotes ? " — " + profitNotes : ""}`},
                  ${profit.toFixed(2)}, 'USD', 'SP_MIGRATION')
          RETURNING id
        `)
          ).rows;
          const voucherId = pn(vRow.id);
          afterCommit.push(() => trackRow(runId, "vouchers", voucherId));

          const clrEntry = (
            await tx.execute(sql`
          INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
          VALUES (${voucherId}, ${clrAcctId}, ${profit.toFixed(2)}, '0.00', 'Accumulated profit clearing')
          RETURNING id
        `)
          ).rows[0];
          afterCommit.push(() => trackRow(runId, "voucher_entries", pn(clrEntry.id)));

          const ourEntry = (
            await tx.execute(sql`
          INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
          VALUES (${voucherId}, ${ourAcctId}, '0.00', ${ourShare.toFixed(2)}, 'Our profit share opening balance')
          RETURNING id
        `)
          ).rows[0];
          afterCommit.push(() => trackRow(runId, "voucher_entries", pn(ourEntry.id)));

          const supEntry = (
            await tx.execute(sql`
          INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
          VALUES (${voucherId}, ${supAcctId}, '0.00', ${supplierShare.toFixed(2)}, 'Supplier profit share opening balance')
          RETURNING id
        `)
          ).rows[0];
          afterCommit.push(() => trackRow(runId, "voucher_entries", pn(supEntry.id)));
          return voucherId;
        });
        for (const record of afterCommit) await record();

        await db.execute(sql`
          UPDATE sp_migration_rehearsal_runs SET status = 'completed', rows_created = 4, completed_at = now() WHERE id = ${runId}
        `);

        return res.json({
          success: true,
          runId,
          voucherId,
          voucherNumber,
          accumulatedProfit: profit,
          ourShare,
          supplierShare,
          ourSplitPct: ourPct,
        });
      } catch (err: unknown) {
        logger.error("[SP Migration] gc-profit-opening error:", { error: err });
        return res.status(500).json({ message: "Internal server error" });
      }
    }
  );
}
