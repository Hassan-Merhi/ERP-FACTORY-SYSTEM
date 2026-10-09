/**
 * rentalUnitsContractsRoutes: RentalGuarantee endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { RentalRoutesContext } from "./_helpers";
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import {
  getCompanyId,
  findOrCreateLedgerAccount,
  maybeRunAutoTransfer,
  ensureMonthlyLedgerRows,
  buildAllocations,
} from "../shared";
import { getClientDate } from "../../../lib/dateUtils";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import {
  propertyUnits,
  propertyContracts,
  propertyMonthlyLedger,
  propertyPayments,
  vouchers,
  voucherEntries,
  interCompanyTransfers,
} from "@shared/schema";
import { parseId } from "../../../lib/parseId";
import { parseMoneyInput } from "../../../lib/money";
import { retireVouchersTx, sessionRetirementActor } from "../../../services/accounting/voucherRetirement";

export function registerRentalGuaranteeRoutes(app: Express, ctx: RentalRoutesContext) {
  const { module, urlPrefix, incomeAccountName, shopExpenseAccountName } = ctx;
  // ── GUARANTEE TO STATEMENT ──
  app.post(`${urlPrefix}/contracts/:id/guarantee-to-statement`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const { amount, cashAccountId, paymentDate, notes } = z
        .object({
          amount: z.union([z.string(), z.number()]).transform((v) => String(v)),
          cashAccountId: z.number().nullable().optional(),
          paymentDate: z.string().optional(),
          notes: z.string().optional(),
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
            const narration = `Guarantee paid - ${unitLabel}`;
            const [v] = await tx
              .insert(vouchers)
              .values({
                companyId,
                voucherNumber: `GUAR-${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${id}`,
                voucherType: "Payment",
                voucherDate: dateStr,
                description: narration,
                totalAmount: amount,
                currency: contract.currency || "USD",
                sourceModule: "ERP",
              })
              .returning();
            await tx.insert(voucherEntries).values([
              { voucherId: v.id, ledgerAccountId: depositAccountId, debitAmount: amount, creditAmount: "0", narration },
              { voucherId: v.id, ledgerAccountId: cashAccountId, debitAmount: "0", creditAmount: amount, narration },
            ]);
          } else {
            // Landlord perspective: company RECEIVES the guarantee — Dr Cash / Cr Tenant Deposits (Liability)
            const depositAccountId = await findOrCreateLedgerAccount(
              tx,
              companyId,
              "Tenant Deposits",
              "Liability",
              "TENANT-DEP"
            );
            const narration = `Guarantee deposit - ${unitLabel}`;
            const [v] = await tx
              .insert(vouchers)
              .values({
                companyId,
                voucherNumber: `GUAR-${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${id}`,
                voucherType: "Receipt",
                voucherDate: dateStr,
                description: narration,
                totalAmount: amount,
                currency: contract.currency || "USD",
                sourceModule: "ERP",
              })
              .returning();
            await tx.insert(voucherEntries).values([
              { voucherId: v.id, ledgerAccountId: cashAccountId, debitAmount: amount, creditAmount: "0", narration },
              { voucherId: v.id, ledgerAccountId: depositAccountId, debitAmount: "0", creditAmount: amount, narration },
            ]);
          }
        }
      });

      // Fire auto-transfer if configured (only for landlord receiving cash)
      if (cashAccountId && !(module === "ERP" || module === "FACTORY")) {
        await maybeRunAutoTransfer(companyId, module, cashAccountId, amount, dateStr, unitLabel, undefined, notes);
      }

      res.json({ ok: true });
    } catch (e: unknown) {
      if (e instanceof z.ZodError)
        return res.status(400).json({ message: e.issues.map((err) => err.message).join(", ") });
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── RESET GUARANTEE STATUS (undo "post to statement") ──
  app.delete(`${urlPrefix}/contracts/:id/guarantee-to-statement`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });

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

      await db.update(propertyContracts).set({ guaranteePostedToStatement: false }).where(eq(propertyContracts.id, id));

      res.json({ ok: true });
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── GUARANTEE TO CASH (release / apply guarantee deposit) ──
  app.post(`${urlPrefix}/contracts/:id/guarantee-to-cash`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const { amount, cashAccountId, paymentDate, notes } = z
        .object({
          amount: z.union([z.string(), z.number()]).transform((v) => String(v)),
          cashAccountId: z.number(),
          paymentDate: z.string().optional(),
          notes: z.string().optional(),
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
      const dateStr = paymentDate || getClientDate(req);

      const tenantPays = module === "ERP" || module === "FACTORY";
      let voucherId: number | null = null;
      await db.transaction(async (tx) => {
        const narration = notes
          ? `Guarantee moved to cash - ${unitLabel} - ${notes}`
          : `Guarantee moved to cash - ${unitLabel}`;
        const [v] = await tx
          .insert(vouchers)
          .values({
            companyId,
            voucherNumber: `GUAR-CASH-${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${id}`,
            voucherType: "Journal",
            voucherDate: dateStr,
            description: narration,
            totalAmount: amount,
            currency: "USD",
            sourceModule: "ERP",
          })
          .returning();
        voucherId = v.id;
        if (tenantPays) {
          // Tenant perspective: company RECOVERS the guarantee back as cash — Dr Cash / Cr Security Deposits Paid (Asset)
          const depositAccountId = await findOrCreateLedgerAccount(
            tx,
            companyId,
            "Security Deposits Paid",
            "Asset",
            "SEC-DEP-PAID"
          );
          await tx.insert(voucherEntries).values([
            { voucherId: v.id, ledgerAccountId: cashAccountId, debitAmount: amount, creditAmount: "0", narration },
            { voucherId: v.id, ledgerAccountId: depositAccountId, debitAmount: "0", creditAmount: amount, narration },
          ]);
        } else {
          // Landlord perspective: deposit moves into cash — Dr Cash / Cr Tenant Deposits (Liability)
          // Auto-transfer then debits Transfer Clearing and credits Cash, netting the cashbox to zero.
          const depositAccountId = await findOrCreateLedgerAccount(
            tx,
            companyId,
            "Tenant Deposits",
            "Liability",
            "TENANT-DEP"
          );
          await tx.insert(voucherEntries).values([
            { voucherId: v.id, ledgerAccountId: cashAccountId, debitAmount: amount, creditAmount: "0", narration },
            { voucherId: v.id, ledgerAccountId: depositAccountId, debitAmount: "0", creditAmount: amount, narration },
          ]);
        }
        // Mark guarantee as paid on the contract
        await tx
          .update(propertyContracts)
          .set({ guaranteePostedToStatement: true, guaranteePostedAmount: amount })
          .where(eq(propertyContracts.id, id));
      });

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

      // Fire auto-transfer if configured — pass the payment ID so deletion can reverse both sides
      await maybeRunAutoTransfer(companyId, module, cashAccountId, amount, dateStr, unitLabel, savedPayment?.id, notes);

      res.json({ ok: true });
    } catch (e: unknown) {
      if (e instanceof z.ZodError)
        return res.status(400).json({ message: e.issues.map((err) => err.message).join(", ") });
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── APPLY GUARANTEE AS RENT ──
  // No cash changes hands — Dr Tenant Deposits (or Sec Dep Paid) / Cr Rent Income (or Rent Expense)
  app.post(`${urlPrefix}/contracts/:id/guarantee-to-rent`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });

      const { amount, paymentDate, notes } = z
        .object({
          amount: z.union([z.string(), z.number()]).transform((v) => String(v)),
          paymentDate: z.string().min(1),
          notes: z.string().optional(),
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

      await ensureMonthlyLedgerRows(contract.id);

      const pd = new Date(paymentDate);
      const y = pd.getUTCFullYear(),
        m = pd.getUTCMonth() + 1;
      // A non-numeric amount allocates nothing and is refused below.
      const totalAmount = parseMoneyInput(amount) ?? 0;

      const [unit] = await db.select().from(propertyUnits).where(eq(propertyUnits.id, contract.unitId));
      const unitLabel = unit ? `${unit.locationGroup}/${unit.unitNumber}` : `Unit#${contract.unitId}`;
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
          ? `Guarantee applied to rent - ${unitLabel} - ${monthSpan} - ${notes}`
          : `Guarantee applied to rent - ${unitLabel} - ${monthSpan}`;

        // Journal: no cash account involved
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
          const [v] = await tx
            .insert(vouchers)
            .values({
              companyId,
              voucherNumber: `GUAR-RENT-${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${id}`,
              voucherType: "Journal",
              voucherDate: paymentDate,
              description: narration,
              totalAmount: amount,
              currency: "USD",
              sourceModule: "ERP",
            })
            .returning();
          voucherId = v.id;
          await tx.insert(voucherEntries).values([
            { voucherId: v.id, ledgerAccountId: expenseAccountId, debitAmount: amount, creditAmount: "0", narration },
            { voucherId: v.id, ledgerAccountId: depositAccountId, debitAmount: "0", creditAmount: amount, narration },
          ]);
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
          const [v] = await tx
            .insert(vouchers)
            .values({
              companyId,
              voucherNumber: `GUAR-RENT-${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${id}`,
              voucherType: "Journal",
              voucherDate: paymentDate,
              description: narration,
              totalAmount: amount,
              currency: "USD",
              sourceModule: "ERP",
            })
            .returning();
          voucherId = v.id;
          await tx.insert(voucherEntries).values([
            { voucherId: v.id, ledgerAccountId: expenseAccountId, debitAmount: amount, creditAmount: "0", narration },
            { voucherId: v.id, ledgerAccountId: depositAccountId, debitAmount: "0", creditAmount: amount, narration },
          ]);
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
          const [v] = await tx
            .insert(vouchers)
            .values({
              companyId,
              voucherNumber: `GUAR-RENT-${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${id}`,
              voucherType: "Journal",
              voucherDate: paymentDate,
              description: narration,
              totalAmount: amount,
              currency: "USD",
              sourceModule: "ERP",
            })
            .returning();
          voucherId = v.id;
          await tx.insert(voucherEntries).values([
            { voucherId: v.id, ledgerAccountId: depositAccountId, debitAmount: amount, creditAmount: "0", narration },
            { voucherId: v.id, ledgerAccountId: incomeAccId, debitAmount: "0", creditAmount: amount, narration },
          ]);
        }

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
      if (e instanceof z.ZodError)
        return res.status(400).json({ message: e.issues.map((err) => err.message).join(", ") });
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── UNDO GUARANTEE APPLIED AS RENT ──
  // Reverses every "[Guarantee applied]" payment on a contract: restores ledger
  // paid_amounts, soft-deletes accounting vouchers, removes inter-company
  // transfers, and resets the contract's guaranteePostedAmount.
  app.post(`${urlPrefix}/contracts/:id/undo-guarantee-as-rent`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });

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

      await db.transaction(async (tx) => {
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
                and(eq(propertyPayments.voucherId, payment.voucherId), sql`${propertyPayments.id} != ${payment.id}`)
              );
            if (siblings.length === 0) {
              await tx.execute(sql`UPDATE vouchers SET deleted_at = NOW() WHERE id = ${payment.voucherId}`);
            }
          }

          // 3. Reverse any auto-transfers created for this payment
          const linkedTransfers = await tx
            .select()
            .from(interCompanyTransfers)
            .where(eq(interCompanyTransfers.sourcePaymentId, payment.id));
          for (const transfer of linkedTransfers) {
            await tx.delete(interCompanyTransfers).where(eq(interCompanyTransfers.id, transfer.id));
            // Wave 16 (A): retired (soft delete with lines, audited here), not hard-deleted.
            await retireVouchersTx(tx, {
              companyId: transfer.fromCompanyId,
              voucherIds: [transfer.fromVoucherId],
              reason: "guarantee-as-rent-undo-transfer",
              actor: sessionRetirementActor(req),
            });
            await retireVouchersTx(tx, {
              companyId: transfer.toCompanyId,
              voucherIds: [transfer.toVoucherId],
              reason: "guarantee-as-rent-undo-transfer",
              actor: sessionRetirementActor(req),
            });
          }

          // 4. Delete the payment row
          await tx.delete(propertyPayments).where(eq(propertyPayments.id, payment.id));
          totalReversed++;
        }

        // guarantee_posted_amount is only managed by "Post to Statement" / "Move to Cash".
        // Applied-as-rent amounts are tracked via payment records ([Guarantee applied] notes).
      });

      res.json({ ok: true, reversed: totalReversed });
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── RECORD PAYMENT ──
}
