/**
 * rentalUnitsContractsRoutes: RentalGuarantee endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import {
  autoTransferCounterpartiesForPayments,
  RentalAutoTransferScopeError,
  runWithAutoTransferCounterparties,
} from "../../../services/rental/autoTransferScope";
import type { RentalRoutesContext } from "./_helpers";
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { getCompanyId, findOrCreateLedgerAccount, maybeRunAutoTransfer, reverseAutoTransfersTx } from "../shared";
import { getClientDate } from "../../../lib/dateUtils";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { eq, and, sql } from "drizzle-orm";
import { propertyUnits, propertyContracts, propertyPayments } from "@shared/schema";
import { validateRequest, validatedInput } from "../../../lib/validateRequest";
import { guaranteeToCashInput, undoGuaranteeAsRentInput } from "../rentalWriteRouteSchemas";
import { retireVouchersTx, sessionRetirementActor } from "../../../services/accounting/voucherRetirement";
import { nextGuaranteeVoucherNumberTx } from "../shared/guarantee-number";
import { shouldRunRentalAutoTransfer } from "../../../services/rental/rentalCashboxPolicy";
import {
  erpRequestSourceId,
  postErpVoucherTx,
  sessionPostingActor as postingActor,
} from "../../../services/accounting/erpVoucherPosting";
import { registerRentalGuaranteeRoutesStep1 } from "./registerRentalGuaranteeRoutesStep1";
import { registerRentalGuaranteeRoutesStep3 } from "./registerRentalGuaranteeRoutesStep3";

export function registerRentalGuaranteeRoutes(app: Express, ctx: RentalRoutesContext) {
  const { incomeAccountName, module, shopExpenseAccountName, urlPrefix } = registerRentalGuaranteeRoutesStep1(app, ctx);
  registerRentalGuaranteeRoutesStep2({ module, urlPrefix }, app);
  registerRentalGuaranteeRoutesStep3({ incomeAccountName, module, shopExpenseAccountName, urlPrefix }, app);
  registerRentalGuaranteeRoutesStep4({ urlPrefix }, app);

  // ── RECORD PAYMENT ──
}

function registerRentalGuaranteeRoutesStep2(
  { module, urlPrefix }: Pick<Awaited<ReturnType<typeof registerRentalGuaranteeRoutesStep1>>, "module" | "urlPrefix">,
  app: Express
) {
  // ── GUARANTEE TO CASH (release / apply guarantee deposit) ──
  app.post(
    `${urlPrefix}/contracts/:id/guarantee-to-cash`,
    requireAuth,
    validateRequest(guaranteeToCashInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const {
          params: { id },
          body: { amount, cashAccountId, paymentDate, notes },
        } = validatedInput(req, guaranteeToCashInput);

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
        const dateStr = paymentDate || getClientDate(req);

        const tenantPays = module === "ERP" || module === "FACTORY";
        const requestSourceId = erpRequestSourceId(req);
        let voucherId: number | null = null;
        let replayed = false;
        await db.transaction(async (tx) => {
          const narration = notes
            ? `Guarantee moved to cash - ${unitLabel}${tenantSuffix} - ${notes}`
            : `Guarantee moved to cash - ${unitLabel}${tenantSuffix}`;
          // Tenant: Dr Cash / Cr Security Deposits Paid (the guarantee comes back).
          // Landlord: Dr Cash / Cr Tenant Deposits; Properties keeps that cash.
          // No automatic intercompany transfer is generated for new receipts.
          const depositAccountId = tenantPays
            ? await findOrCreateLedgerAccount(tx, companyId, "Security Deposits Paid", "Asset", "SEC-DEP-PAID")
            : await findOrCreateLedgerAccount(tx, companyId, "Tenant Deposits", "Liability", "TENANT-DEP");
          const posted = await postErpVoucherTx(tx, {
            companyId,
            voucherType: "Journal",
            voucherDate: dateStr,
            description: narration,
            currency: "USD",
            lines: [
              { ledgerAccountId: cashAccountId, debit: amount, narration },
              { ledgerAccountId: depositAccountId, credit: amount, narration },
            ],
            voucherNumber: await nextGuaranteeVoucherNumberTx(tx, { companyId, contractId: id, kind: "GUAR-CASH" }),
            source: { type: "rental-guarantee-cash", id: `${id}:${requestSourceId}` },
            actor: postingActor(req),
          });
          voucherId = posted.voucher.id;
          replayed = posted.replayed;
          // Mark guarantee as paid on the contract
          await tx
            .update(propertyContracts)
            .set({ guaranteePostedToStatement: true, guaranteePostedAmount: amount })
            .where(eq(propertyContracts.id, id));
        });

        // A resent request (same clientRequestId) posted nothing new.
        if (replayed) return res.json({ ok: true });

        // Record in payments log so it's visible in cash flow / payments history
        const pd = new Date(dateStr);
        const [savedPayment] = await db
          .insert(propertyPayments)
          .values({
            companyId,
            module,
            contractId: contract.id,
            unitId: contract.unitId,
            ledgerRowId: null,
            cashAccountId,
            voucherId,
            amount,
            paymentDate: dateStr,
            forYear: pd.getUTCFullYear(),
            forMonth: pd.getUTCMonth() + 1,
            notes: notes ? `[Guarantee release] ${notes}` : `[Guarantee release] ${unitLabel}`,
          })
          .returning();

        // Only legacy ERP/Factory rent flows can use configured intercompany transfers.
        if (shouldRunRentalAutoTransfer(module)) {
          await maybeRunAutoTransfer(
            companyId,
            module,
            cashAccountId,
            amount,
            dateStr,
            unitLabel,
            savedPayment?.id,
            notes
          );
        }

        res.json({ ok: true });
      } catch (e: unknown) {
        res.status(500).json({ message: getErrorMessage(e) });
      }
    }
  );
  return {};
}

function registerRentalGuaranteeRoutesStep4(
  { urlPrefix }: Pick<Awaited<ReturnType<typeof registerRentalGuaranteeRoutesStep1>>, "urlPrefix">,
  app: Express
) {
  // ── UNDO GUARANTEE APPLIED AS RENT ──
  // Reverses every "[Guarantee applied]" payment on a contract: restores ledger
  // paid_amounts, soft-deletes accounting vouchers, removes inter-company
  // transfers, and resets the contract's guaranteePostedAmount.
  app.post(
    `${urlPrefix}/contracts/:id/undo-guarantee-as-rent`,
    requireAuth,
    validateRequest(undoGuaranteeAsRentInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const { id } = validatedInput(req, undoGuaranteeAsRentInput).params;

        const [contract] = await db
          .select()
          .from(propertyContracts)
          .where(and(eq(propertyContracts.id, id), eq(propertyContracts.companyId, companyId)));
        if (!contract) return res.status(404).json({ message: "Contract not found" });

        // Find all guarantee-applied payments for this contract
        const appliedPayments = await db
          .select()
          .from(propertyPayments)
          .where(
            and(
              eq(propertyPayments.contractId, id),
              eq(propertyPayments.companyId, companyId),
              sql`${propertyPayments.notes} LIKE '%[Guarantee applied]%'`
            )
          );

        if (appliedPayments.length === 0) {
          return res.json({ ok: true, reversed: 0, message: "No guarantee-applied payments found" });
        }

        let totalReversed = 0;

        await runWithAutoTransferCounterparties(
          await autoTransferCounterpartiesForPayments(
            companyId,
            appliedPayments.map((payment) => payment.id)
          ),
          () =>
            db.transaction(async (tx) => {
              for (const payment of appliedPayments) {
                // 1. Reverse the monthly ledger paid_amount
                if (payment.ledgerRowId) {
                  await tx.execute(sql`
              UPDATE property_monthly_ledger
              SET paid_amount = GREATEST(0, paid_amount - ${payment.amount}::numeric)
              WHERE id = ${payment.ledgerRowId}
            `);
                }

                // 2. Soft-delete the voucher only if no other payment shares it
                if (payment.voucherId) {
                  const siblings = await tx
                    .select({ id: propertyPayments.id })
                    .from(propertyPayments)
                    .where(
                      and(
                        eq(propertyPayments.voucherId, payment.voucherId),
                        sql`${propertyPayments.id} != ${payment.id}`
                      )
                    );
                  if (siblings.length === 0) {
                    // Phase 22 (B): retired (audited, number and posting identity
                    // released) instead of a bare deleted_at update.
                    await retireVouchersTx(tx, {
                      companyId,
                      voucherIds: [payment.voucherId],
                      reason: "guarantee-as-rent-undo",
                      actor: sessionRetirementActor(req),
                    });
                  }
                }

                // 3. Reverse any auto-transfers created for this payment: both sides,
                //    the receiving company's included (main #2138), retired and
                //    audited with the signed-in user (wave 16 A).
                await reverseAutoTransfersTx(tx, [payment.id], {
                  reason: "guarantee-as-rent-undo-transfer",
                  actor: sessionRetirementActor(req),
                });

                // 4. Delete the payment row
                await tx.delete(propertyPayments).where(eq(propertyPayments.id, payment.id));
                totalReversed++;
              }

              // guarantee_posted_amount is only managed by "Post to Statement" / "Move to Cash".
              // Applied-as-rent amounts are tracked via payment records ([Guarantee applied] notes).
            })
        );

        res.json({ ok: true, reversed: totalReversed });
      } catch (e: unknown) {
        if (e instanceof RentalAutoTransferScopeError) return res.status(e.status).json({ message: e.message });
        res.status(500).json({ message: getErrorMessage(e) });
      }
    }
  );
  return {};
}
