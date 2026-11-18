// Extracted from ./suppliers.ts
import type { Request, Response } from "express";
import { errorStatus, getErrorMessage } from "../../../../lib/httpHandlers";
import { ZodError } from "zod";
import { accountHistoryErrorResponse, requestRole } from "../../../../services/accounting/accountHistoryPolicy";
import { FactorySupplierWriteError } from "./factorySupplierWrites";
import type { DbTransaction } from "../../../../db";
import { sql } from "drizzle-orm";

export const FACTORY_SUPPLIER_HAS_HISTORY_CODE = "FACTORY_SUPPLIER_HAS_HISTORY" as const;

export const FACTORY_SUPPLIER_HAS_HISTORY_MESSAGE =
  "This supplier has history (containers, stock, payments, transfers, voucher lines, linked suppliers or an opening balance), so it cannot be permanently deleted.";

/** Rows that record a factory supplier's history, by kind (phase 19 B, PE6). */
export async function factorySupplierHistoryCountsTx(
  tx: DbTransaction,
  companyId: number,
  supplierId: number
): Promise<Record<string, number>> {
  // History rows are counted in the supplier's company; voucher lines and FX
  // transfers in any company (a line naming the supplier is its history wherever it is).
  const result = await tx.execute<Record<string, number>>(sql`
    SELECT
      (SELECT COUNT(*) FROM factory_containers
        WHERE company_id = ${companyId} AND supplier_id = ${supplierId})::int AS containers,
      (SELECT COUNT(*) FROM factory_raw_stock rs
        WHERE rs.company_id = ${companyId}
          AND (rs.commission_supplier_id = ${supplierId}
               OR rs.container_id IN (SELECT id FROM factory_containers
                                       WHERE company_id = ${companyId} AND supplier_id = ${supplierId})))::int AS "rawStock",
      (SELECT COUNT(*) FROM factory_raw_material_adjustments
        WHERE company_id = ${companyId} AND supplier_id = ${supplierId})::int AS "rawMaterialAdjustments",
      (SELECT COUNT(*) FROM factory_offload_additional_charges
        WHERE company_id = ${companyId} AND supplier_id = ${supplierId})::int AS "offloadCharges",
      (SELECT COUNT(*) FROM factory_mix_batch_sources
        WHERE supplier_id = ${supplierId} OR inventory_supplier_id = ${supplierId})::int AS "mixSources",
      (SELECT COUNT(*) FROM factory_waste_entries
        WHERE company_id = ${companyId} AND supplier_id = ${supplierId})::int AS waste,
      (SELECT COUNT(*) FROM factory_supplier_payments
        WHERE company_id = ${companyId} AND supplier_id = ${supplierId})::int AS payments,
      (SELECT COUNT(*) FROM factory_supplier_fx_transfers
        WHERE from_supplier_id = ${supplierId} OR to_supplier_id = ${supplierId})::int AS "fxTransfers",
      (SELECT COUNT(*) FROM voucher_entries WHERE factory_supplier_id = ${supplierId})::int AS "voucherLines",
      (SELECT COUNT(*) FROM factory_suppliers
        WHERE company_id = ${companyId} AND parent_id = ${supplierId})::int AS "linkedSuppliers"
  `);
  const row = (result.rows[0] ?? {}) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value ?? 0)]));
}

export function factorySupplierActor(req: Request) {
  return {
    userId: req.session.userId!,
    username: req.session.username || "unknown",
    role: requestRole(req),
  };
}

export function sendFactorySupplierWriteError(res: Response, error: unknown, fallback: number) {
  const refused = accountHistoryErrorResponse(error);
  if (refused) return res.status(refused.status).json(refused.body);
  if (error instanceof FactorySupplierWriteError) return res.status(error.status).json({ message: error.message });
  if (error instanceof ZodError) return res.status(400).json({ message: getErrorMessage(error) });
  return res.status(errorStatus(error, fallback)).json({ message: getErrorMessage(error) });
}
