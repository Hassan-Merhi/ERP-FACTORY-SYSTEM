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
import { eq, and, sql } from "drizzle-orm";
import { propertyUnits, propertyContracts, propertyPayments } from "@shared/schema";
import { postErpVoucherTx, sessionPostingActor } from "../../../services/accounting/erpVoucherPosting";
import { nextGuaranteeVoucherNumberTx } from "../shared/guarantee-number";
import { logAudit } from "../../_helpers";
import { parseMoneyInput } from "../../../lib/money";
import { validateRequest, validatedInput } from "../../../lib/validateRequest";
import { endContractInput } from "../rentalWriteRouteSchemas";

export function registerRentalContractEndRoutes(app: Express, ctx: RentalRoutesContext) {
  const { module, urlPrefix } = ctx;
  // ── END CONTRACT ──
  app.post(
    `${urlPrefix}/contracts/:id/end`,
    requireAuth,
    validateRequest(endContractInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const {
          params: { id },
          body: { endDate, notes, refundGuarantee, refundAmount, refundCashAccountId, refundNotes },
        } = validatedInput(req, endContractInput);

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
        const tenantSuffix =
          module === "PROPERTIES" && contract.tenantName.trim() ? ` - Tenant: ${contract.tenantName.trim()}` : "";
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
              ? `Guarantee refund on departure - ${unitLabel}${tenantSuffix} - ${refundNotes}`
              : `Guarantee refund on departure - ${unitLabel}${tenantSuffix}`;

            if (refundCashAccountId) {
              // Tenant: the guarantee comes back — Dr Cash / Cr Security Deposits Paid.
              // Landlord: the deposit is returned — Dr Tenant Deposits / Cr Cash.
              const depositAccountId = tenantPays
                ? await findOrCreateLedgerAccount(tx, companyId, "Security Deposits Paid", "Asset", "SEC-DEP-PAID")
                : await findOrCreateLedgerAccount(tx, companyId, "Tenant Deposits", "Liability", "TENANT-DEP");
              await postErpVoucherTx(tx, {
                companyId,
                voucherType: tenantPays ? "Receipt" : "Payment",
                voucherDate: dateStr,
                description: narration,
                currency: contract.currency || "USD",
                lines: tenantPays
                  ? [
                      { ledgerAccountId: refundCashAccountId, debit: amt, narration },
                      { ledgerAccountId: depositAccountId, credit: amt, narration },
                    ]
                  : [
                      { ledgerAccountId: depositAccountId, debit: amt, narration },
                      { ledgerAccountId: refundCashAccountId, credit: amt, narration },
                    ],
                voucherNumber: await nextGuaranteeVoucherNumberTx(tx, {
                  companyId,
                  contractId: id,
                  kind: "GUAR-REFUND",
                }),
                // One refund per contract end (an ended contract is not ended again).
                source: { type: "rental-guarantee-refund", id },
                actor: sessionPostingActor(req, "Guarantee refund on contract end"),
              });
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
          // Phase 21 (B): the end-of-contract audit commits with it.
          await logAudit(
            {
              userId: req.session.userId!,
              username: req.session.username || "unknown",
              companyId,
              action: "update",
              tableName: "property_contracts",
              recordId: id,
              recordIdentifier: `Contract#${id}`,
              changes: { status: { old: "ACTIVE", new: "ENDED" }, endDate: { old: null, new: endDate } },
            },
            tx
          );
        });

        res.json({ ok: true });
      } catch (e: unknown) {
        res.status(500).json({ message: getErrorMessage(e) });
      }
    }
  );
}
