// Extracted from ./guarantees.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { buildAllocations, ensureMonthlyLedgerRows, findOrCreateLedgerAccount, getCompanyId } from "../shared";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { and, eq, sql } from "drizzle-orm";
import { propertyContracts, propertyMonthlyLedger, propertyPayments, propertyUnits } from "@shared/schema";
import { validateRequest, validatedInput } from "../../../lib/validateRequest";
import { guaranteeToRentInput } from "../rentalWriteRouteSchemas";
import { parseMoneyInput } from "../../../lib/money";
import { nextGuaranteeVoucherNumberTx } from "../shared/guarantee-number";
import {
  erpRequestSourceId,
  postErpVoucherTx,
  sessionPostingActor as postingActor,
} from "../../../services/accounting/erpVoucherPosting";
import { registerRentalGuaranteeRoutesStep1 } from "./registerRentalGuaranteeRoutesStep1";

export function registerRentalGuaranteeRoutesStep3(
  {
    incomeAccountName,
    module,
    shopExpenseAccountName,
    urlPrefix,
  }: Pick<
    Awaited<ReturnType<typeof registerRentalGuaranteeRoutesStep1>>,
    "incomeAccountName" | "module" | "shopExpenseAccountName" | "urlPrefix"
  >,
  app: Express
) {
  // ── APPLY GUARANTEE AS RENT ──
  // No cash changes hands — Dr Tenant Deposits (or Sec Dep Paid) / Cr Rent Income (or Rent Expense)
  app.post(
    `${urlPrefix}/contracts/:id/guarantee-to-rent`,
    requireAuth,
    validateRequest(guaranteeToRentInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const {
          params: { id },
          body: { amount, paymentDate, notes },
        } = validatedInput(req, guaranteeToRentInput);

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

        await ensureMonthlyLedgerRows(contract.id);

        const pd = new Date(paymentDate);
        const y = pd.getUTCFullYear(),
          m = pd.getUTCMonth() + 1;
        // A non-numeric amount allocates nothing and is refused below.
        const totalAmount = parseMoneyInput(amount) ?? 0;

        const [unit] = await db.select().from(propertyUnits).where(eq(propertyUnits.id, contract.unitId));
        const unitLabel = unit ? `${unit.locationGroup}/${unit.unitNumber}` : `Unit#${contract.unitId}`;
        const tenantSuffix =
          module === "PROPERTIES" && contract.tenantName.trim() ? ` - Tenant: ${contract.tenantName.trim()}` : "";
        const isShop = unit?.unitType === "SHOP";
        const tenantPays = module === "ERP" || module === "FACTORY";

        const allocations = await buildAllocations(contract.id, y, m, totalAmount, contract.rentalAmount as string);
        if (!allocations.length)
          return res.status(400).json({ message: "No outstanding rent to apply the guarantee to for that period." });

        await db.transaction(async (tx) => {
          // Ensure a ledger row exists for every allocated month
          for (const alloc of allocations) {
            await tx
              .insert(propertyMonthlyLedger)
              .values({
                companyId,
                module,
                contractId: contract.id,
                unitId: contract.unitId,
                year: alloc.year,
                month: alloc.month,
                expectedAmount: contract.rentalAmount,
                paidAmount: "0",
              })
              .onConflictDoNothing({
                target: [propertyMonthlyLedger.contractId, propertyMonthlyLedger.year, propertyMonthlyLedger.month],
              });
          }

          const monthSpan =
            allocations.length > 1
              ? `${String(allocations[0].month).padStart(2, "0")}/${allocations[0].year} – ${String(allocations[allocations.length - 1].month).padStart(2, "0")}/${allocations[allocations.length - 1].year}`
              : `${String(m).padStart(2, "0")}/${y}`;
          const narration = notes
            ? `Guarantee applied to rent - ${unitLabel} - ${monthSpan}${tenantSuffix} - ${notes}`
            : `Guarantee applied to rent - ${unitLabel} - ${monthSpan}${tenantSuffix}`;

          // Journal: no cash account involved
          const requestSourceId = erpRequestSourceId(req);
          let voucherId: number;
          if (tenantPays && isShop) {
            // Tenant/shop pays rent: Dr Rent Expense - Shops (expense↑) / Cr Security Deposits Paid (asset↓)
            const expenseAccountId = await findOrCreateLedgerAccount(
              tx,
              companyId,
              shopExpenseAccountName,
              "Indirect Expense",
              "SHOP-RENT-EXP"
            );
            const depositAccountId = await findOrCreateLedgerAccount(
              tx,
              companyId,
              "Security Deposits Paid",
              "Asset",
              "SEC-DEP-PAID"
            );
            const { voucher: v } = await postErpVoucherTx(tx, {
              companyId,
              voucherType: "Journal",
              voucherDate: paymentDate,
              description: narration,
              currency: "USD",
              lines: [
                { ledgerAccountId: expenseAccountId, debit: amount, narration },
                { ledgerAccountId: depositAccountId, credit: amount, narration },
              ],
              voucherNumber: await nextGuaranteeVoucherNumberTx(tx, { companyId, contractId: id, kind: "GUAR-RENT" }),
              source: { type: "rental-guarantee-rent", id: `${id}:${requestSourceId}` },
              actor: postingActor(req),
            });
            voucherId = v.id;
          } else if (tenantPays) {
            // Non-shop tenant: Dr Rent Expense / Cr Security Deposits Paid
            const expenseAccountId = await findOrCreateLedgerAccount(
              tx,
              companyId,
              incomeAccountName,
              "Indirect Expense",
              "RENT-EXP"
            );
            const depositAccountId = await findOrCreateLedgerAccount(
              tx,
              companyId,
              "Security Deposits Paid",
              "Asset",
              "SEC-DEP-PAID"
            );
            const { voucher: v } = await postErpVoucherTx(tx, {
              companyId,
              voucherType: "Journal",
              voucherDate: paymentDate,
              description: narration,
              currency: "USD",
              lines: [
                { ledgerAccountId: expenseAccountId, debit: amount, narration },
                { ledgerAccountId: depositAccountId, credit: amount, narration },
              ],
              voucherNumber: await nextGuaranteeVoucherNumberTx(tx, { companyId, contractId: id, kind: "GUAR-RENT" }),
              source: { type: "rental-guarantee-rent", id: `${id}:${requestSourceId}` },
              actor: postingActor(req),
            });
            voucherId = v.id;
          } else {
            // Landlord: Dr Tenant Deposits (liability↓) / Cr Rent Income (income↑)
            const depositAccountId = await findOrCreateLedgerAccount(
              tx,
              companyId,
              "Tenant Deposits",
              "Liability",
              "TENANT-DEP"
            );
            const incomeAccId = await findOrCreateLedgerAccount(
              tx,
              companyId,
              incomeAccountName,
              "Income",
              "RENT-INC",
              "Indirect Income"
            );
            const { voucher: v } = await postErpVoucherTx(tx, {
              companyId,
              voucherType: "Journal",
              voucherDate: paymentDate,
              description: narration,
              currency: "USD",
              lines: [
                { ledgerAccountId: depositAccountId, debit: amount, narration },
                { ledgerAccountId: incomeAccId, credit: amount, narration },
              ],
              voucherNumber: await nextGuaranteeVoucherNumberTx(tx, { companyId, contractId: id, kind: "GUAR-RENT" }),
              source: { type: "rental-guarantee-rent", id: `${id}:${requestSourceId}` },
              actor: postingActor(req),
            });
            voucherId = v.id;
          }

          // A resent request (same clientRequestId) returned the voucher it
          // already posted; its payment rows exist and are not added twice.
          const [alreadyApplied] = await tx
            .select({ id: propertyPayments.id })
            .from(propertyPayments)
            .where(and(eq(propertyPayments.companyId, companyId), eq(propertyPayments.voucherId, voucherId)))
            .limit(1);
          if (alreadyApplied) return;

          // Create one payment row per allocated month and update ledger
          for (const alloc of allocations) {
            const [row] = await tx
              .select()
              .from(propertyMonthlyLedger)
              .where(
                and(
                  eq(propertyMonthlyLedger.contractId, contract.id),
                  eq(propertyMonthlyLedger.year, alloc.year),
                  eq(propertyMonthlyLedger.month, alloc.month)
                )
              );
            await tx
              .insert(propertyPayments)
              .values({
                companyId,
                module,
                contractId: contract.id,
                unitId: contract.unitId,
                ledgerRowId: row.id,
                cashAccountId: null,
                voucherId,
                amount: alloc.chunk,
                paymentDate: paymentDate,
                forYear: alloc.year,
                forMonth: alloc.month,
                notes:
                  allocations.length > 1
                    ? `[Guarantee applied] ${narration} | Split from ${amount}`
                    : `[Guarantee applied] ${narration}`,
              })
              .returning();
            await tx.execute(sql`
            UPDATE property_monthly_ledger SET paid_amount = paid_amount + ${alloc.chunk}::numeric WHERE id = ${row.id}
          `);
          }

          // guarantee_posted_amount is only managed by "Post to Statement" / "Move to Cash".
          // Applied-as-rent amounts are tracked via payment records ([Guarantee applied] notes).
        });

        res.json({ ok: true, allocations });
      } catch (e: unknown) {
        res.status(500).json({ message: getErrorMessage(e) });
      }
    }
  );
  return {};
}
