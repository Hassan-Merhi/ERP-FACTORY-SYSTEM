/**
 * rentalUnitsContractsRoutes: RentalContractEnd endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { RentalRoutesContext } from "./_helpers";
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { getCompanyId, findOrCreateLedgerAccount } from "../shared";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { propertyUnits, propertyContracts, propertyPayments, vouchers, voucherEntries } from "@shared/schema";
import { parseId } from "../../../lib/parseId";
import { logAudit } from "../../_helpers";
import { parseMoneyInput } from "../../../lib/money";

export function registerRentalContractEndRoutes(app: Express, ctx: RentalRoutesContext) {
  const { module, urlPrefix } = ctx;
  // ── END CONTRACT ──
  app.post(`${urlPrefix}/contracts/:id/end`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const { endDate, notes, refundGuarantee, refundAmount, refundCashAccountId, refundNotes } = z
        .object({
          endDate: z.string().min(1),
          notes: z.string().optional(),
          refundGuarantee: z.boolean().optional().default(false),
          refundAmount: z
            .union([z.string(), z.number()])
            .transform((v) => String(v))
            .optional(),
          refundCashAccountId: z.number().nullable().optional(),
          refundNotes: z.string().optional(),
        })
        .parse(req.body);

      const [contract] = await db
        .select()
        .from(propertyContracts)
        .where(
          and(
            eq(propertyContracts.id, id),
            eq(propertyContracts.companyId, companyId),
            eq(propertyContracts.module, module)
          )
        );
      if (!contract) return res.status(404).json({ message: "Contract not found" });

      const [unit] = await db.select().from(propertyUnits).where(eq(propertyUnits.id, contract.unitId));
      const unitLabel = unit ? `${unit.locationGroup}/${unit.unitNumber}` : `Unit#${contract.unitId}`;
      const tenantPays = module === "ERP" || module === "FACTORY";

      await db.transaction(async (tx) => {
        await tx
          .update(propertyContracts)
          .set({
            status: "ENDED",
            endDate: endDate,
            notes: notes ? `${contract.notes ? contract.notes + "\n" : ""}END: ${notes}` : contract.notes,
          })
          .where(eq(propertyContracts.id, id));

        const end = new Date(endDate);
        const ey = end.getUTCFullYear(),
          em = end.getUTCMonth() + 1;
        await tx.execute(sql`
          DELETE FROM property_monthly_ledger
          WHERE contract_id = ${id} AND paid_amount = 0
            AND ((year > ${ey}) OR (year = ${ey} AND month > ${em}))
        `);

        // ── Optional: refund remaining guarantee to tenant ──
        if (refundGuarantee && refundAmount && parseMoneyInput(refundAmount)?.gt(0)) {
          const amt = refundAmount;
          const dateStr = endDate;
          const narration = refundNotes
            ? `Guarantee refund on departure - ${unitLabel} - ${refundNotes}`
            : `Guarantee refund on departure - ${unitLabel}`;

          if (refundCashAccountId) {
            if (tenantPays) {
              // Tenant gets guarantee back: Dr Security Deposits Paid (asset↓) / Cr Cash (we return money)
              // Actually: landlord returns money to tenant — Dr Cash reversal: Cr Cash / Dr Sec Dep Paid
              // We PAID the guarantee as an asset (Sec Dep Paid debit). Refund: Dr Cash received back / Cr Sec Dep Paid cleared
              const depositAccountId = await findOrCreateLedgerAccount(
                tx,
                companyId,
                "Security Deposits Paid",
                "Asset",
                "SEC-DEP-PAID"
              );
              const [v] = await tx
                .insert(vouchers)
                .values({
                  companyId,
                  voucherNumber: `GUAR-REFUND-${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${id}`,
                  voucherType: "Receipt",
                  voucherDate: dateStr,
                  description: narration,
                  totalAmount: amt,
                  currency: contract.currency || "USD",
                  sourceModule: "ERP",
                })
                .returning();
              await tx.insert(voucherEntries).values([
                {
                  voucherId: v.id,
                  ledgerAccountId: refundCashAccountId,
                  debitAmount: amt,
                  creditAmount: "0",
                  narration,
                },
                { voucherId: v.id, ledgerAccountId: depositAccountId, debitAmount: "0", creditAmount: amt, narration },
              ]);
            } else {
              // Landlord returns deposit to departing tenant: Dr Tenant Deposits (liability↓) / Cr Cash (we pay out)
              const depositAccountId = await findOrCreateLedgerAccount(
                tx,
                companyId,
                "Tenant Deposits",
                "Liability",
                "TENANT-DEP"
              );
              const [v] = await tx
                .insert(vouchers)
                .values({
                  companyId,
                  voucherNumber: `GUAR-REFUND-${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${id}`,
                  voucherType: "Payment",
                  voucherDate: dateStr,
                  description: narration,
                  totalAmount: amt,
                  currency: contract.currency || "USD",
                  sourceModule: "ERP",
                })
                .returning();
              await tx.insert(voucherEntries).values([
                { voucherId: v.id, ledgerAccountId: depositAccountId, debitAmount: amt, creditAmount: "0", narration },
                {
                  voucherId: v.id,
                  ledgerAccountId: refundCashAccountId,
                  debitAmount: "0",
                  creditAmount: amt,
                  narration,
                },
              ]);
            }
          }

          // Record in payments log as a guarantee activity (ledgerRowId: null so it shows in guarantee section)
          await tx.insert(propertyPayments).values({
            companyId,
            module,
            contractId: contract.id,
            unitId: contract.unitId,
            ledgerRowId: null,
            cashAccountId: refundCashAccountId ?? null,
            voucherId: null,
            amount: amt,
            paymentDate: dateStr,
            forYear: new Date(dateStr).getUTCFullYear(),
            forMonth: new Date(dateStr).getUTCMonth() + 1,
            notes: `[Guarantee refund] ${narration}`,
          });
        }
      });

      await logAudit({
        userId: req.session.userId!,
        username: req.session.username || "unknown",
        companyId,
        action: "update",
        tableName: "property_contracts",
        recordId: id,
        recordIdentifier: `Contract#${id}`,
        changes: { status: { old: "ACTIVE", new: "ENDED" }, endDate: { old: null, new: endDate } },
      });
      res.json({ ok: true });
    } catch (e: unknown) {
      if (e instanceof z.ZodError)
        return res.status(400).json({ message: e.issues.map((err) => err.message).join(", ") });
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });
}
