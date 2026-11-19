// Extracted from ./guarantees.ts to keep that module under the source-size cap.
import type { RentalRoutesContext } from "./_helpers";
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { findOrCreateLedgerAccount, getCompanyId } from "../shared";
import { getClientDate } from "../../../lib/dateUtils";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { and, eq, sql } from "drizzle-orm";
import { propertyContracts, propertyUnits } from "@shared/schema";
import { validateRequest, validatedInput } from "../../../lib/validateRequest";
import { guaranteeToStatementInput, resetGuaranteeToStatementInput } from "../rentalWriteRouteSchemas";
import { nextGuaranteeVoucherNumberTx } from "../shared/guarantee-number";
import { postErpVoucherTx, sessionPostingActor as postingActor } from "../../../services/accounting/erpVoucherPosting";

export function registerRentalGuaranteeRoutesStep1(app: Express, ctx: RentalRoutesContext) {
  const { module, urlPrefix, incomeAccountName, shopExpenseAccountName } = ctx;
  // ── GUARANTEE TO STATEMENT ──
  app.post(
    `${urlPrefix}/contracts/:id/guarantee-to-statement`,
    requireAuth,
    validateRequest(guaranteeToStatementInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const {
          params: { id },
          body: { amount, cashAccountId, paymentDate, notes },
        } = validatedInput(req, guaranteeToStatementInput);

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

        await db.transaction(async (tx) => {
          await tx
            .update(propertyContracts)
            .set({
              guaranteePostedToStatement: true,
              guaranteePostedAmount: amount,
              notes: notes
                ? `${contract.notes ? contract.notes + "\n" : ""}GUARANTEE→STMT: ${amount} (${notes})`
                : contract.notes,
            })
            .where(eq(propertyContracts.id, id));

          // Guard against duplicate accounting: if a guarantee voucher already exists
          // for this contract (e.g. "Reset Status" was clicked but didn't delete it),
          // skip creating a new one — just the flag update above is enough.
          const existingGuar = await tx.execute(
            sql`SELECT id FROM vouchers WHERE company_id = ${companyId} AND voucher_number LIKE ${"GUAR-%-" + id} AND deleted_at IS NULL LIMIT 1`
          );
          if ((existingGuar.rows ?? existingGuar).length > 0) {
            return; // voucher already in ledger — flag restored, no duplicate needed
          }

          if (cashAccountId) {
            const tenantPays = module === "ERP" || module === "FACTORY";
            if (tenantPays) {
              // Tenant perspective: company PAYS the guarantee out — Dr Security Deposits Paid (Asset) / Cr Cash
              const depositAccountId = await findOrCreateLedgerAccount(
                tx,
                companyId,
                "Security Deposits Paid",
                "Asset",
                "SEC-DEP-PAID"
              );
              const narration = `Guarantee paid - ${unitLabel}${tenantSuffix}`;
              await postErpVoucherTx(tx, {
                companyId,
                voucherType: "Payment",
                voucherDate: dateStr,
                description: narration,
                currency: contract.currency || "USD",
                lines: [
                  { ledgerAccountId: depositAccountId, debit: amount, narration },
                  { ledgerAccountId: cashAccountId, credit: amount, narration },
                ],
                voucherNumber: await nextGuaranteeVoucherNumberTx(tx, { companyId, contractId: id, kind: "GUAR" }),
                source: { type: "rental-guarantee-statement", id: String(id) },
                actor: postingActor(req),
              });
            } else {
              // Landlord perspective: company RECEIVES the guarantee — Dr Cash / Cr Tenant Deposits (Liability)
              const depositAccountId = await findOrCreateLedgerAccount(
                tx,
                companyId,
                "Tenant Deposits",
                "Liability",
                "TENANT-DEP"
              );
              const narration = `Guarantee deposit - ${unitLabel}${tenantSuffix}`;
              await postErpVoucherTx(tx, {
                companyId,
                voucherType: "Receipt",
                voucherDate: dateStr,
                description: narration,
                currency: contract.currency || "USD",
                lines: [
                  { ledgerAccountId: cashAccountId, debit: amount, narration },
                  { ledgerAccountId: depositAccountId, credit: amount, narration },
                ],
                voucherNumber: await nextGuaranteeVoucherNumberTx(tx, { companyId, contractId: id, kind: "GUAR" }),
                source: { type: "rental-guarantee-statement", id: String(id) },
                actor: postingActor(req),
              });
            }
          }
        });

        // Properties guarantee receipts stay in the company cashbox. Historical
        // intercompany voucher links are preserved for audit and reversals.

        res.json({ ok: true });
      } catch (e: unknown) {
        res.status(500).json({ message: getErrorMessage(e) });
      }
    }
  );

  // ── RESET GUARANTEE STATUS (undo "post to statement") ──
  app.delete(
    `${urlPrefix}/contracts/:id/guarantee-to-statement`,
    requireAuth,
    validateRequest(resetGuaranteeToStatementInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const { id } = validatedInput(req, resetGuaranteeToStatementInput).params;

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

        await db
          .update(propertyContracts)
          .set({ guaranteePostedToStatement: false })
          .where(eq(propertyContracts.id, id));

        res.json({ ok: true });
      } catch (e: unknown) {
        res.status(500).json({ message: getErrorMessage(e) });
      }
    }
  );
  return { incomeAccountName, module, shopExpenseAccountName, urlPrefix };
}
