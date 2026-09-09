import type { Express, Request, Response } from "express";
import { and, eq, sql } from "drizzle-orm";
import { spContainers, spOffloadCharges, spStockMovements, voucherEntries, vouchers } from "@shared/schema";
import { requireAuth, requireRole } from "../../auth";
import { db, type RawQueryRow } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { adjustSpInventoryAtomic, respondToSpInventoryIntegrityError } from "../../services/sp/spInventoryIntegrity";
import {
  appendSpLifecycleNote,
  buildSpReversalEntries,
  normalizeSpLifecycleReason,
  respondToSpLifecycleError,
  SpLifecycleError,
} from "../../services/sp/spLifecyclePolicy";
import { SP_RELEASE_CURRENCY, SP_RELEASE_EXCHANGE_RATE } from "../../services/sp/spReleasePolicy";
import { requireSpCompany } from "./spHelpers";

/**
 * Raw rows read by the Supplier Partner offload lifecycle.
 *
 * These queries use `SELECT *`, so each interface names only the columns this
 * module actually reads. `numeric` columns arrive as decimal strings and are
 * declared as such rather than assumed to be numbers.
 */
interface SpOffloadRow {
  id: number;
  container_id: number;
  created_at: Date;
  voucher_id_stock: number | null;
  voucher_id_reversal: number | null;
}

interface SpContainerRow {
  id: number;
  status: string;
  notes: string | null;
}

interface VoucherTotalRow {
  id: number;
  total_amount: string | null;
}

interface SpPrepaidChargeRow {
  id: number;
  amount_used_usd: string | null;
}

interface VoucherIdRow {
  id: number;
  company_id: number;
}

/** The integrity projection; every column is a COUNT, cast to int in the query. */
interface SpLifecycleIntegrityRow {
  unbalanced_voucher_count: number;
  stock_cost_mismatch_count: number;
  prepaid_mismatch_count: number;
  reversal_voucher_mismatch_count: number;
  container_state_mismatch_count: number;
}

function lifecycleDate(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) return new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new SpLifecycleError("The lifecycle date must use YYYY-MM-DD format.", "SP_LIFECYCLE_CONFLICT", 400);
  }
  return normalized;
}

export async function ensureSpOffloadReversalStorage(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS sp_offload_reversals (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      container_id integer NOT NULL,
      offload_id integer NOT NULL,
      reversal_date date NOT NULL,
      reason text NOT NULL,
      reversed_by text,
      voucher_ids_original jsonb NOT NULL DEFAULT '[]'::jsonb,
      voucher_ids_reversal jsonb NOT NULL DEFAULT '[]'::jsonb,
      snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamp NOT NULL DEFAULT now(),
      CONSTRAINT sp_offload_reversals_offload_unique UNIQUE (offload_id)
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS sp_offload_reversals_company_container_idx
      ON sp_offload_reversals(company_id, container_id)
  `);
}

async function createExactVoucherReversal(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: {
    companyId: number;
    originalVoucherId: number;
    reversalDate: string;
    numberPrefix: string;
    description: string;
  }
): Promise<number> {
  const [originalVoucher] = (
    await tx.execute<RawQueryRow<VoucherTotalRow>>(sql`
    SELECT * FROM vouchers
    WHERE id = ${input.originalVoucherId}
      AND company_id = ${input.companyId}
      AND deleted_at IS NULL
    FOR UPDATE
  `)
  ).rows;
  if (!originalVoucher) {
    throw new SpLifecycleError(
      `Voucher #${input.originalVoucherId} is unavailable; no reversal was posted.`,
      "SP_LIFECYCLE_CONFLICT",
      409
    );
  }

  const originalEntries = await tx
    .select()
    .from(voucherEntries)
    .where(eq(voucherEntries.voucherId, input.originalVoucherId));
  if (originalEntries.length === 0) {
    throw new SpLifecycleError(
      `Voucher #${input.originalVoucherId} has no entries; no reversal was posted.`,
      "SP_LIFECYCLE_CONFLICT",
      409
    );
  }

  const [reversalVoucher] = await tx
    .insert(vouchers)
    .values({
      companyId: input.companyId,
      voucherType: "Journal",
      voucherNumber: `${input.numberPrefix}-${input.originalVoucherId}-${Date.now()}`,
      voucherDate: input.reversalDate,
      description: input.description,
      totalAmount: String(originalVoucher.total_amount ?? originalVoucher.totalAmount ?? "0"),
      currency: SP_RELEASE_CURRENCY,
      exchangeRate: SP_RELEASE_EXCHANGE_RATE,
      sourceModule: "SP",
    })
    .returning();

  await tx
    .insert(voucherEntries)
    .values(buildSpReversalEntries(originalEntries, reversalVoucher.id, input.description));
  return reversalVoucher.id;
}

export function registerSpOffloadLifecycleRoutes(app: Express): void {
  void ensureSpOffloadReversalStorage().catch((error) => {
    logger.warn("[SP] Offload reversal storage initialization deferred", {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  app.post("/api/sp/offloads/:id/reverse", requireAuth, requireRole("Admin"), async (req: Request, res: Response) => {
    try {
      await ensureSpOffloadReversalStorage();
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;

      const offloadId = Number(req.params.id);
      if (!Number.isInteger(offloadId) || offloadId <= 0) {
        return res.status(400).json({ message: "Invalid Supplier Partner offload ID" });
      }

      const reason = normalizeSpLifecycleReason(req.body?.reason, "reverse this Supplier Partner offload");
      const reversalDate = lifecycleDate(req.body?.reversalDate);

      const result = await db.transaction(async (tx) => {
        const [offload] = (
          await tx.execute<RawQueryRow<SpOffloadRow>>(sql`
            SELECT * FROM sp_offloads
            WHERE id = ${offloadId} AND company_id = ${companyId}
            FOR UPDATE
          `)
        ).rows;
        if (!offload) {
          throw new SpLifecycleError("Supplier Partner offload not found.", "SP_LIFECYCLE_CONFLICT", 404);
        }

        const [duplicate] = (
          await tx.execute<RawQueryRow<{ id: number }>>(sql`
            SELECT id FROM sp_offload_reversals WHERE offload_id = ${offloadId} FOR UPDATE
          `)
        ).rows;
        if (duplicate) {
          throw new SpLifecycleError("This offload has already been reversed.", "SP_LIFECYCLE_ALREADY_DONE", 409);
        }

        const [container] = (
          await tx.execute<RawQueryRow<SpContainerRow>>(sql`
            SELECT * FROM sp_containers
            WHERE id = ${offload.container_id} AND company_id = ${companyId}
            FOR UPDATE
          `)
        ).rows;
        if (!container || container.status !== "offloaded") {
          throw new SpLifecycleError(
            "Only the currently offloaded container can be reversed.",
            "SP_LIFECYCLE_CONFLICT",
            409
          );
        }

        const [laterOffload] = (
          await tx.execute<RawQueryRow<{ id: number }>>(sql`
            SELECT id FROM sp_offloads
            WHERE company_id = ${companyId}
              AND container_id = ${offload.container_id}
              AND id > ${offloadId}
              AND NOT EXISTS (
                SELECT 1 FROM sp_offload_reversals r WHERE r.offload_id = sp_offloads.id
              )
            LIMIT 1
          `)
        ).rows;
        if (laterOffload) {
          throw new SpLifecycleError(
            "A newer active offload exists for this container; reverse the newest offload first.",
            "SP_LIFECYCLE_CONFLICT",
            409
          );
        }

        const movements = await tx
          .select()
          .from(spStockMovements)
          .where(and(eq(spStockMovements.companyId, companyId), eq(spStockMovements.offloadId, offloadId)));
        if (movements.length === 0) {
          throw new SpLifecycleError(
            "The offload has no stock movements and cannot be reversed safely.",
            "SP_LIFECYCLE_CONFLICT",
            409
          );
        }

        for (const movement of movements) {
          const qtyIn = Number(movement.qtyIn ?? 0);
          const qtyRemaining = Number(movement.qtyRemaining ?? 0);
          if (Math.abs(qtyIn - qtyRemaining) > 0.0001) {
            throw new SpLifecycleError(
              `Stock lot #${movement.id} has been consumed. Reverse its Supplier Partner sales before reversing the offload.`,
              "SP_LIFECYCLE_CONFLICT",
              409
            );
          }
        }

        const charges = await tx
          .select()
          .from(spOffloadCharges)
          .where(and(eq(spOffloadCharges.companyId, companyId), eq(spOffloadCharges.offloadId, offloadId)));

        for (const charge of charges) {
          if (charge.chargeType !== "prepaid_used" || !charge.prepaidChargeId) continue;
          const [prepaid] = (
            await tx.execute<RawQueryRow<SpPrepaidChargeRow>>(sql`
              SELECT * FROM sp_prepaid_charges
              WHERE id = ${charge.prepaidChargeId} AND company_id = ${companyId}
              FOR UPDATE
            `)
          ).rows;
          if (!prepaid || Number(prepaid.amount_used_usd ?? 0) + 0.0001 < Number(charge.amountUsd ?? 0)) {
            throw new SpLifecycleError(
              `Prepaid charge #${charge.prepaidChargeId} cannot be restored exactly.`,
              "SP_LIFECYCLE_CONFLICT",
              409
            );
          }
          await tx.execute(sql`
              UPDATE sp_prepaid_charges
              SET amount_used_usd = amount_used_usd - ${Number(charge.amountUsd ?? 0)}
              WHERE id = ${charge.prepaidChargeId} AND company_id = ${companyId}
            `);
        }

        const originalVoucherIds: number[] = [
          Number(offload.voucher_id_reversal),
          Number(offload.voucher_id_stock),
        ].filter((id) => Number.isInteger(id) && id > 0);

        const parentVouchers = (
          await tx.execute<RawQueryRow<VoucherIdRow>>(sql`
            SELECT id, company_id
            FROM vouchers
            WHERE source_module = 'SP'
              AND voucher_number LIKE ${`SP-AGENT-${offload.container_id}-%`}
              AND deleted_at IS NULL
              AND created_at >= ${offload.created_at}
            ORDER BY id
            FOR UPDATE
          `)
        ).rows;

        const reversalVoucherIds: number[] = [];
        for (const originalVoucherId of originalVoucherIds) {
          reversalVoucherIds.push(
            await createExactVoucherReversal(tx, {
              companyId,
              originalVoucherId,
              reversalDate,
              numberPrefix: "SP-OFFLOAD-REV",
              description: `Supplier Partner offload #${offloadId} reversal — ${reason}`,
            })
          );
        }
        for (const parentVoucher of parentVouchers) {
          originalVoucherIds.push(Number(parentVoucher.id));
          reversalVoucherIds.push(
            await createExactVoucherReversal(tx, {
              companyId: Number(parentVoucher.company_id),
              originalVoucherId: Number(parentVoucher.id),
              reversalDate,
              numberPrefix: "SP-AGENT-REV",
              description: `Supplier Partner parent-agent offload #${offloadId} reversal — ${reason}`,
            })
          );
        }

        for (const movement of movements) {
          await adjustSpInventoryAtomic(tx, {
            companyId,
            locationId: Number(movement.locationId),
            stockItemId: movement.stockItemId,
            deltaQty: -Number(movement.qtyIn),
            incomingRate: Number(movement.finalUnitCostUsd),
            context: `SP offload reversal #${offloadId} lot #${movement.id}`,
            sourceVoucherType: "SP_OFFLOAD_REVERSAL",
            sourceVoucherId: offloadId,
          });
          await tx
            .update(spStockMovements)
            .set({ qtyRemaining: "0", sourceType: "offload_reversed" })
            .where(and(eq(spStockMovements.id, movement.id), eq(spStockMovements.companyId, companyId)));
        }

        const notes = appendSpLifecycleNote({
          existingNotes: container.notes,
          action: "OFFLOAD REVERSED",
          reason,
          username: req.user?.username ?? req.session?.username,
          date: reversalDate,
        });
        await tx
          .update(spContainers)
          .set({ status: "open", notes })
          .where(and(eq(spContainers.id, offload.container_id), eq(spContainers.companyId, companyId)));

        const snapshot = {
          offload,
          movements,
          charges,
          parentVoucherIds: parentVouchers.map((voucher) => Number(voucher.id)),
        };
        const [reversalRow] = (
          await tx.execute<RawQueryRow<Record<string, unknown>>>(sql`
            INSERT INTO sp_offload_reversals (
              company_id, container_id, offload_id, reversal_date, reason, reversed_by,
              voucher_ids_original, voucher_ids_reversal, snapshot
            ) VALUES (
              ${companyId}, ${offload.container_id}, ${offloadId}, ${reversalDate}, ${reason},
              ${req.user?.username ?? req.session?.username ?? null},
              ${JSON.stringify(originalVoucherIds)}::jsonb,
              ${JSON.stringify(reversalVoucherIds)}::jsonb,
              ${JSON.stringify(snapshot)}::jsonb
            )
            RETURNING *
          `)
        ).rows;

        return {
          reversal: reversalRow,
          containerId: Number(offload.container_id),
          restoredPrepaidChargeCount: charges.filter((charge) => charge.chargeType === "prepaid_used").length,
          reversedMovementCount: movements.length,
          originalVoucherIds,
          reversalVoucherIds,
        };
      });

      res.json(result);
    } catch (error: unknown) {
      if (respondToSpLifecycleError(res, error)) return;
      if (respondToSpInventoryIntegrityError(res, error)) return;
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/sp/reconciliation/offloads", requireAuth, requireRole("Admin"), async (req: Request, res: Response) => {
    try {
      await ensureSpOffloadReversalStorage();
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;

      const [report] = (
        await db.execute<RawQueryRow<SpLifecycleIntegrityRow>>(sql`
          WITH voucher_balance AS (
            SELECT v.id,
                   COALESCE(SUM(ve.debit_amount::numeric), 0) AS debit,
                   COALESCE(SUM(ve.credit_amount::numeric), 0) AS credit
            FROM vouchers v
            LEFT JOIN voucher_entries ve ON ve.voucher_id = v.id
            WHERE v.source_module = 'SP'
              AND v.deleted_at IS NULL
              AND (v.company_id = ${companyId} OR v.voucher_number LIKE 'SP-AGENT-%')
            GROUP BY v.id
          ),
          active_offloads AS (
            SELECT o.* FROM sp_offloads o
            WHERE o.company_id = ${companyId}
              AND NOT EXISTS (SELECT 1 FROM sp_offload_reversals r WHERE r.offload_id = o.id)
          ),
          stock_totals AS (
            SELECT o.id,
                   COALESCE(SUM(sm.qty_in::numeric * sm.final_unit_cost_usd::numeric), 0) AS movement_value,
                   o.total_final_cost_usd::numeric AS offload_value
            FROM active_offloads o
            LEFT JOIN sp_stock_movements sm
              ON sm.offload_id = o.id AND sm.company_id = o.company_id AND sm.source_type <> 'offload_reversed'
            GROUP BY o.id, o.total_final_cost_usd
          )
          SELECT
            (SELECT COUNT(*)::int FROM voucher_balance WHERE ABS(debit - credit) > 0.0001) AS unbalanced_voucher_count,
            (SELECT COUNT(*)::int FROM stock_totals WHERE ABS(movement_value - offload_value) > 0.01) AS stock_cost_mismatch_count,
            (SELECT COUNT(*)::int FROM sp_prepaid_charges
              WHERE company_id = ${companyId}
                AND (amount_used_usd::numeric < -0.0001 OR amount_used_usd::numeric > amount_paid_usd::numeric + 0.0001)
            ) AS prepaid_mismatch_count,
            (SELECT COUNT(*)::int FROM sp_offload_reversals r
              WHERE r.company_id = ${companyId}
                AND jsonb_array_length(r.voucher_ids_original) <> jsonb_array_length(r.voucher_ids_reversal)
            ) AS reversal_voucher_mismatch_count,
            (SELECT COUNT(*)::int FROM sp_containers c
              WHERE c.company_id = ${companyId}
                AND c.status = 'offloaded'
                AND NOT EXISTS (
                  SELECT 1 FROM active_offloads o WHERE o.container_id = c.id
                )
            ) AS container_state_mismatch_count
        `)
      ).rows;

      const mismatches =
        Number(report?.unbalanced_voucher_count ?? 0) +
        Number(report?.stock_cost_mismatch_count ?? 0) +
        Number(report?.prepaid_mismatch_count ?? 0) +
        Number(report?.reversal_voucher_mismatch_count ?? 0) +
        Number(report?.container_state_mismatch_count ?? 0);

      res.json({
        status: mismatches === 0 ? "PASS" : "FAIL",
        mismatchCount: mismatches,
        checks: {
          unbalancedVouchers: Number(report?.unbalanced_voucher_count ?? 0),
          stockCost: Number(report?.stock_cost_mismatch_count ?? 0),
          prepaidBalances: Number(report?.prepaid_mismatch_count ?? 0),
          reversalVoucherPairs: Number(report?.reversal_voucher_mismatch_count ?? 0),
          containerState: Number(report?.container_state_mismatch_count ?? 0),
        },
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
