// Extracted from ./rentalPaymentsAccrualRoutes.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { getCompanyId, monthlyLedgerRowsForRead, type RentalModule } from "./shared";
import { db, pool } from "../../db";
import { getRentalBillingDay, getRentalPeriodDueDate } from "../../services/rental/rentalPeriodService";
import { requireAuth } from "../../auth";
import { and, desc, eq, or } from "drizzle-orm";
import { propertyContracts, propertyMonthlyLedger, propertyPayments, propertyUnits } from "@shared/schema";
import { parseId } from "../../lib/parseId";
import { getClientDate } from "../../lib/dateUtils";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { registerRentalPaymentsAccrualRoutesStep1 } from "./registerRentalPaymentsAccrualRoutesStep1";

export function registerRentalPaymentsAccrualRoutesStep3(
  { tag }: Pick<Awaited<ReturnType<typeof registerRentalPaymentsAccrualRoutesStep1>>, "tag">,
  app: Express,
  module: RentalModule,
  urlPrefix: string
) {
  // Payment deletion is exclusively owned by the preceding atomic central route.

  // ── UNIT DETAIL (ledger view) ──
  // FIX #6: uses asOfDate for all calculations; returns backend-calculated
  //          per-row fields and separate postedPayments/scheduledPayments.
  app.get(`${urlPrefix}/units/:id/detail`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const unitId = parseId(req.params.id);
      if (unitId === null) return res.status(400).json({ message: "Invalid id" });

      const asOfDate = getClientDate(req);

      let isShared = false;
      let [unit] = await db
        .select()
        .from(propertyUnits)
        .where(
          and(eq(propertyUnits.id, unitId), eq(propertyUnits.companyId, companyId), eq(propertyUnits.module, module))
        );

      // Same-company internal Factory shops appear in Properties without copying
      // units, contracts, ledgers or payment rows.
      if (!unit && module === "PROPERTIES") {
        const [factoryUnit] = await db
          .select()
          .from(propertyUnits)
          .where(
            and(
              eq(propertyUnits.id, unitId),
              eq(propertyUnits.companyId, companyId),
              eq(propertyUnits.module, "FACTORY"),
              eq(propertyUnits.unitType, "SHOP"),
              eq(propertyUnits.active, true)
            )
          );
        if (factoryUnit) {
          const [internalContract] = await db
            .select({ id: propertyContracts.id })
            .from(propertyContracts)
            .where(
              and(
                eq(propertyContracts.unitId, unitId),
                eq(propertyContracts.companyId, companyId),
                eq(propertyContracts.module, "FACTORY"),
                eq(propertyContracts.status, "ACTIVE"),
                eq(propertyContracts.isInternal, true)
              )
            );
          if (internalContract) {
            unit = factoryUnit;
            isShared = true;
          }
        }
      }

      if (!unit) {
        try {
          const [sharedContract] = await db
            .select()
            .from(propertyContracts)
            .where(
              and(
                eq(propertyContracts.unitId, unitId),
                eq(propertyContracts.linkedCompanyId, companyId),
                eq(propertyContracts.status, "ACTIVE")
              )
            );
          if (sharedContract) {
            const [ownerUnit] = await db.select().from(propertyUnits).where(eq(propertyUnits.id, unitId));
            if (ownerUnit) {
              unit = ownerUnit;
              isShared = true;
            }
          }
        } catch (sharedErr: unknown) {
          logger.warn(`${tag} shared-detail skipped:`, { error: getErrorMessage(sharedErr).split("\n")[0] });
        }
      }
      if (!unit) return res.status(404).json({ message: "Unit not found" });

      const [contract] = await db
        .select()
        .from(propertyContracts)
        .where(
          and(
            isShared
              ? module === "PROPERTIES"
                ? or(
                    eq(propertyContracts.linkedCompanyId, companyId),
                    and(
                      eq(propertyContracts.companyId, companyId),
                      eq(propertyContracts.module, "FACTORY"),
                      eq(propertyContracts.isInternal, true)
                    )
                  )
                : eq(propertyContracts.linkedCompanyId, companyId)
              : eq(propertyContracts.companyId, companyId),
            ...(isShared ? [] : [eq(propertyContracts.module, module)]),
            eq(propertyContracts.unitId, unitId),
            eq(propertyContracts.status, "ACTIVE")
          )
        );

      type PropertyPaymentRow = typeof propertyPayments.$inferSelect;
      type RentalLedgerRow = typeof propertyMonthlyLedger.$inferSelect & {
        dueDate: string;
        isDue: boolean;
        expectedAsOf: number;
        effectivePaidAmount: number;
        allPostedPaid: number;
        scheduledAmount: number;
        outstanding: number;
        prepaidCredit: number;
        status: string;
      };
      let ledger: RentalLedgerRow[] = [];
      let postedPayments: PropertyPaymentRow[] = [];
      let scheduledPayments: PropertyPaymentRow[] = [];
      let guaranteePayments: PropertyPaymentRow[] = [];

      if (contract) {
        // Phase 19 (B), PE2: a GET only reads; due months with no stored row
        // are computed in memory (it created and updated monthly rows).
        const billingDay = getRentalBillingDay(contract.startDate as string);

        const rawLedger = await monthlyLedgerRowsForRead(contract.id, asOfDate);

        const allPayments = await db
          .select()
          .from(propertyPayments)
          .where(eq(propertyPayments.contractId, contract.id))
          .orderBy(desc(propertyPayments.paymentDate));

        guaranteePayments = allPayments.filter(
          (p) => p.ledgerRowId === null || (p.notes ?? "").includes("[Guarantee release]")
        );
        const rentPaymentsAll = allPayments.filter(
          (p) => p.ledgerRowId !== null && !(p.notes ?? "").includes("[Guarantee release]")
        );

        // Separate posted (effective) and scheduled
        postedPayments = rentPaymentsAll.filter(
          (p) => p.postingStatus === "POSTED" && String(p.paymentDate) <= asOfDate
        );
        scheduledPayments = rentPaymentsAll.filter((p) => p.postingStatus === "SCHEDULED");

        // Per-row effective paid totals (POSTED + payment_date <= asOfDate) — used for balance widget
        const { rows: paymentSums } = await pool.query<{ ledger_row_id: string; total_paid: string }>(
          `SELECT ledger_row_id, COALESCE(SUM(amount::numeric), 0) AS total_paid
           FROM property_payments
           WHERE contract_id = $1 AND posting_status = 'POSTED' AND payment_date <= $2
           GROUP BY ledger_row_id`,
          [contract.id, asOfDate]
        );
        const paidByRowId = new Map(paymentSums.map((r) => [parseInt(r.ledger_row_id), toMoney(r.total_paid)]));

        // Per-row ALL posted paid totals (no date filter) — used for the statement PAID column.
        // Needed because payments can be POSTED with a future payment_date (e.g. tenant pays on
        // Jul 17 for a Jul 20 due date). Those payments are fully posted and should show in the
        // statement even though payment_date > asOfDate.
        const { rows: allPostedSums } = await pool.query<{ ledger_row_id: string; total_paid: string }>(
          `SELECT ledger_row_id, COALESCE(SUM(amount::numeric), 0) AS total_paid
           FROM property_payments
           WHERE contract_id = $1 AND posting_status = 'POSTED'
           GROUP BY ledger_row_id`,
          [contract.id]
        );
        const allPostedByRowId = new Map(allPostedSums.map((r) => [parseInt(r.ledger_row_id), toMoney(r.total_paid)]));

        // Per-row scheduled totals
        const { rows: scheduledSums } = await pool.query<{ ledger_row_id: string; total_scheduled: string }>(
          `SELECT ledger_row_id, COALESCE(SUM(amount::numeric), 0) AS total_scheduled
           FROM property_payments
           WHERE contract_id = $1 AND posting_status = 'SCHEDULED'
           GROUP BY ledger_row_id`,
          [contract.id]
        );
        const scheduledByRowId = new Map(
          scheduledSums.map((r) => [parseInt(r.ledger_row_id), toMoney(r.total_scheduled)])
        );

        // Enrich each ledger row with backend-calculated fields
        ledger = rawLedger.map((r) => {
          const dueDate = getRentalPeriodDueDate(r.year, r.month, billingDay);
          const isDue = dueDate <= asOfDate;
          // Exact decimals: the balance figures are differences of cent amounts,
          // and float subtraction left residue such as 0.09999999999999432.
          const effectivePaid = paidByRowId.get(r.id) ?? new MoneyDecimal(0);
          // allPostedPaid: all POSTED payments for this ledger row, regardless of payment_date.
          // This is what the statement PAID column should display so that future-dated posted
          // payments (e.g. paid a few days early) are shown correctly.
          const allPosted = allPostedByRowId.get(r.id) ?? new MoneyDecimal(0);
          const scheduled = scheduledByRowId.get(r.id) ?? new MoneyDecimal(0);
          const expected = toMoney(r.expectedAmount as string);
          const expectedAsOfExact = isDue ? expected : new MoneyDecimal(0);
          const effectivePaidAmount = effectivePaid.toNumber();
          const allPostedPaid = allPosted.toNumber();
          const scheduledAmt = scheduled.toNumber();
          const expectedAmount = expected.toNumber();
          const expectedAsOf = expectedAsOfExact.toNumber();
          const outstanding = MoneyDecimal.max(0, expectedAsOfExact.minus(effectivePaid)).toNumber();
          const prepaidCredit = MoneyDecimal.max(0, effectivePaid.minus(expectedAsOfExact)).toNumber();

          // Use allPostedPaid (not effectivePaidAmount) for status so that a POSTED future-dated
          // payment is correctly labelled PAID/PREPAID rather than NOT_DUE.
          let status: string;
          if (scheduledAmt > 0.005 && allPostedPaid < 0.005) {
            status = "SCHEDULED";
          } else if (!isDue && allPostedPaid < 0.005 && scheduledAmt < 0.005) {
            status = "NOT_DUE";
          } else if (!isDue && allPostedPaid > 0.005) {
            status = "PREPAID";
          } else if (isDue && allPostedPaid < 0.005) {
            status = "DUE";
          } else if (isDue && allPostedPaid > 0.005 && outstanding > 0.005 && allPostedPaid < expectedAmount - 0.005) {
            status = "PARTIALLY_PAID";
          } else if (isDue && allPostedPaid > expectedAmount + 0.005) {
            status = "OVERPAID";
          } else {
            status = "PAID";
          }

          return {
            ...r,
            dueDate,
            isDue,
            expectedAsOf,
            effectivePaidAmount,
            allPostedPaid,
            scheduledAmount: scheduledAmt,
            outstanding,
            prepaidCredit,
            status,
          };
        });
      }

      const pastContracts = await db
        .select()
        .from(propertyContracts)
        .where(
          and(
            eq(propertyContracts.companyId, companyId),
            eq(propertyContracts.module, module),
            eq(propertyContracts.unitId, unitId),
            eq(propertyContracts.status, "ENDED")
          )
        )
        .orderBy(desc(propertyContracts.endDate));

      res.json({
        unit,
        contract: contract ?? null,
        ledger,
        postedPayments,
        scheduledPayments,
        guaranteePayments,
        pastContracts,
        isShared,
      });
    } catch (e: unknown) {
      logger.error(`${tag} detail:`, { error: e });
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });
  return {};
}
