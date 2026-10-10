/**
 * rentalUnitsContractsRoutes: RentalUnitsRead endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { RentalRoutesContext } from "./_helpers";
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { getCompanyId, ensureMonthlyForCompany, postRentAccrualForCompany } from "../shared";
import { postDueScheduledRentalPayments } from "../../../services/rental/rentalPaymentPostingService";
import { getRentalBillingDay, getRentalPeriodDueDate } from "../../../services/rental/rentalPeriodService";
import { getClientDate } from "../../../lib/dateUtils";
import { db, pool } from "../../../db";
import { requireAuth } from "../../../auth";
import { eq, and, sql, inArray } from "drizzle-orm";
import { propertyUnits, propertyContracts, propertyMonthlyLedger, propertyPayments, companies } from "@shared/schema";
import { computeNextBillingDate } from "./_helpers";
import { sumMoney, toMoney } from "../../../lib/money";

export function registerRentalUnitsReadRoutes(app: Express, ctx: RentalRoutesContext) {
  const { module, urlPrefix, incomeAccountName, shopExpenseAccountName, tag } = ctx;

  app.get(`${urlPrefix}/units`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const unitType = (req.query.unitType as string) || "WAREHOUSE";

      const asOf = getClientDate(req);
      await ensureMonthlyForCompany(companyId, module, asOf);

      // FIX #5: sequential awaited processing so scheduled posting runs before
      //          accrual classification (avoids a race where an already-posted
      //          payment is re-classified as due-unaccrued in the same request).
      if ((module === "ERP" || module === "FACTORY") && unitType === "SHOP") {
        try {
          await postDueScheduledRentalPayments(companyId, module, asOf, shopExpenseAccountName);
        } catch (e: unknown) {
          logger.warn(`${tag} page-load scheduled-posting failed:`, { error: getErrorMessage(e).split("\n")[0] });
        }
        try {
          await postRentAccrualForCompany(companyId, shopExpenseAccountName, module, incomeAccountName, asOf);
        } catch (e: unknown) {
          logger.warn(`${tag} page-load accrual failed:`, { error: getErrorMessage(e).split("\n")[0] });
        }
      }

      const regularUnits = await db
        .select()
        .from(propertyUnits)
        .where(
          and(
            eq(propertyUnits.companyId, companyId),
            eq(propertyUnits.module, module),
            eq(propertyUnits.unitType, unitType),
            eq(propertyUnits.active, true)
          )
        )
        .orderBy(
          propertyUnits.locationGroup,
          propertyUnits.sortOrder,
          sql`NULLIF(regexp_replace(${propertyUnits.unitNumber}, '[^0-9]', '', 'g'), '')::bigint nulls last`,
          propertyUnits.unitNumber
        );

      // When viewing SHOP type, also pull in any WAREHOUSE units that are marked as
      // "internal lease" (the company occupies its own warehouse) so they appear in both views.
      let internalWarehouseUnits: typeof regularUnits = [];
      if (unitType === "SHOP") {
        const allWarehouseUnits = await db
          .select()
          .from(propertyUnits)
          .where(
            and(
              eq(propertyUnits.companyId, companyId),
              eq(propertyUnits.module, module),
              eq(propertyUnits.unitType, "WAREHOUSE"),
              eq(propertyUnits.active, true)
            )
          );
        if (allWarehouseUnits.length) {
          const internalContracts = await db
            .select()
            .from(propertyContracts)
            .where(
              and(
                eq(propertyContracts.companyId, companyId),
                eq(propertyContracts.module, module),
                inArray(
                  propertyContracts.unitId,
                  allWarehouseUnits.map((u) => u.id)
                ),
                eq(propertyContracts.status, "ACTIVE"),
                eq(propertyContracts.isInternal, true)
              )
            );
          const internalUnitIds = new Set(internalContracts.map((c) => c.unitId));
          internalWarehouseUnits = allWarehouseUnits.filter((u) => internalUnitIds.has(u.id));
        }
      }

      const units = [...regularUnits, ...internalWarehouseUnits];
      const unitIds = units.map((u) => u.id);
      const contracts = unitIds.length
        ? await db
            .select()
            .from(propertyContracts)
            .where(
              and(
                eq(propertyContracts.companyId, companyId),
                eq(propertyContracts.module, module),
                inArray(propertyContracts.unitId, unitIds),
                eq(propertyContracts.status, "ACTIVE")
              )
            )
        : [];
      const contractByUnit = new Map<number, (typeof contracts)[0]>();
      contracts.forEach((c) => contractByUnit.set(c.unitId, c));

      const contractIds = contracts.map((c) => c.id);
      const outstandingByContract = new Map<number, number>(); // stores (expectedAsOf - paidAsOf), can be negative
      const expectedAsOfByContractOuter = new Map<number, number>(); // FIX #8: expose expectedAsOf
      const paidAsOfByContract = new Map<number, number>();
      const scheduledAmountByContract = new Map<number, number>();
      const totalPaidByContract = new Map<number, number>();
      const guaranteeAppliedByContract = new Map<number, number>();

      if (contractIds.length > 0) {
        // Billing-day-aware expected: only sum months whose billing date has arrived as of asOf
        const ledgerRowsForExp = await db
          .select({
            contractId: propertyMonthlyLedger.contractId,
            year: propertyMonthlyLedger.year,
            month: propertyMonthlyLedger.month,
            expectedAmount: propertyMonthlyLedger.expectedAmount,
          })
          .from(propertyMonthlyLedger)
          .where(inArray(propertyMonthlyLedger.contractId, contractIds));

        const ledgerByContract = new Map<number, typeof ledgerRowsForExp>();
        for (const row of ledgerRowsForExp) {
          const arr = ledgerByContract.get(row.contractId) ?? [];
          arr.push(row);
          ledgerByContract.set(row.contractId, arr);
        }

        const expectedAsOfByContract = new Map<number, number>();
        for (const c of contracts) {
          const billingDay = getRentalBillingDay(c.startDate as string);
          const rows = ledgerByContract.get(c.id) ?? [];
          const expected = sumMoney(
            rows
              .filter((row) => getRentalPeriodDueDate(row.year, row.month, billingDay) <= asOf)
              .map((row) => row.expectedAmount as string)
          );
          expectedAsOfByContract.set(c.id, expected.toNumber());
        }

        // POSTED rent payments as of asOf date (authoritative — not the paidAmount cache).
        // Exclude ledger_row_id IS NULL rows: those are guarantee deposits/releases which
        // do not represent rent paid and would double-count vs. the per-month paidAmount.
        const { rows: postedRows } = await pool.query<{ contract_id: string; paid: string }>(
          `SELECT contract_id, COALESCE(SUM(amount::numeric), 0) AS paid
           FROM property_payments
           WHERE contract_id = ANY($1) AND posting_status = 'POSTED' AND payment_date <= $2
             AND ledger_row_id IS NOT NULL
           GROUP BY contract_id`,
          [contractIds, asOf]
        );
        postedRows.forEach((r) => {
          const n = parseInt(r.contract_id);
          paidAsOfByContract.set(n, toMoney(r.paid).toNumber());
          totalPaidByContract.set(n, toMoney(r.paid).toNumber());
        });

        // SCHEDULED (future) payment totals
        const { rows: scheduledRows } = await pool.query<{ contract_id: string; scheduled: string }>(
          `SELECT contract_id, COALESCE(SUM(amount::numeric), 0) AS scheduled
           FROM property_payments
           WHERE contract_id = ANY($1) AND posting_status = 'SCHEDULED'
           GROUP BY contract_id`,
          [contractIds]
        );
        scheduledRows.forEach((r) =>
          scheduledAmountByContract.set(parseInt(r.contract_id), toMoney(r.scheduled).toNumber())
        );

        // outstanding = expected - POSTED paid (negative = prepaid credit)
        for (const c of contracts) {
          const expected = expectedAsOfByContract.get(c.id) ?? 0;
          const paid = paidAsOfByContract.get(c.id) ?? 0;
          outstandingByContract.set(c.id, toMoney(expected).minus(paid).toNumber());
          expectedAsOfByContractOuter.set(c.id, expected); // FIX #8
        }

        // [Guarantee applied] payments
        const appliedRows = await db
          .select({
            contractId: propertyPayments.contractId,
            total: sql<string>`COALESCE(SUM(${propertyPayments.amount}), 0)`,
          })
          .from(propertyPayments)
          .where(
            and(
              inArray(propertyPayments.contractId, contractIds),
              sql`${propertyPayments.notes} LIKE '%[Guarantee applied]%'`
            )
          )
          .groupBy(propertyPayments.contractId);
        appliedRows.forEach((r) => guaranteeAppliedByContract.set(r.contractId, Number(r.total)));
      }

      const ownedResults = units.map((u) => {
        const c = contractByUnit.get(u.id);
        const appliedAsRent = c ? (guaranteeAppliedByContract.get(c.id) ?? 0) : 0;
        const guaranteeRemaining = c ? Math.max(0, toMoney(c.guaranteeAmount).minus(appliedAsRent).toNumber()) : null;
        // FIX #8: separate non-negative outstanding and credit fields
        const rawOutstanding = c ? (outstandingByContract.get(c.id) ?? 0) : null;
        const expectedAsOf = c ? (expectedAsOfByContractOuter.get(c.id) ?? 0) : null;
        const paidAsOf = c ? (paidAsOfByContract.get(c.id) ?? 0) : null;
        const scheduledAmount = c ? (scheduledAmountByContract.get(c.id) ?? 0) : null;
        const outstanding = rawOutstanding !== null ? Math.max(0, rawOutstanding) : null;
        const prepaidCredit = rawOutstanding !== null && rawOutstanding < 0 ? Math.abs(rawOutstanding) : null;
        const billingDay = c ? getRentalBillingDay(c.startDate as string) : null;
        const nextBillingDate = c && billingDay !== null ? computeNextBillingDate(billingDay, asOf) : null;
        return {
          ...u,
          contract: c ?? null,
          expectedAsOf,
          outstanding,
          paidAsOf,
          totalPaid: paidAsOf,
          scheduledAmount,
          prepaidCredit,
          billingDay,
          nextBillingDate,
          guaranteeRemaining,
          isShared: false,
          ownerCompanyName: null as string | null,
        };
      });

      // ── Shared contracts: contracts from OTHER companies that link to this company ──
      // Wrapped in its own try/catch — if the column hasn't been migrated yet this
      // gracefully returns [] so owned units always load.
      let sharedResults: typeof ownedResults = [];
      try {
        // Shared contracts (rented FROM another company) always appear in the Shops view only.
        // The owner may classify the unit differently in their system, so we ignore unitType
        // and pin shared units to the SHOP view to avoid them leaking into Warehouses.
        if (unitType === "SHOP") {
          const sharedContracts = await db
            .select()
            .from(propertyContracts)
            .where(and(eq(propertyContracts.linkedCompanyId, companyId), eq(propertyContracts.status, "ACTIVE")));

          if (sharedContracts.length > 0) {
            const sharedUnitIds = sharedContracts.map((c) => c.unitId);
            // No unitType filter — show all shared contracts in the Shops view regardless of
            // how the owner classified the unit in their own system.
            const sharedUnits = await db.select().from(propertyUnits).where(inArray(propertyUnits.id, sharedUnitIds));
            const sharedUnitMap = new Map(sharedUnits.map((u) => [u.id, u]));

            const sharedContractIds = sharedContracts.map((c) => c.id);
            const sharedOutstanding = new Map<number, number>();
            const sharedExpected = new Map<number, number>();
            const sharedPaid = new Map<number, number>();
            const sharedScheduled = new Map<number, number>();

            // Billing-day-aware expected for shared contracts
            const sharedLedgerRows = await db
              .select({
                contractId: propertyMonthlyLedger.contractId,
                year: propertyMonthlyLedger.year,
                month: propertyMonthlyLedger.month,
                expectedAmount: propertyMonthlyLedger.expectedAmount,
              })
              .from(propertyMonthlyLedger)
              .where(inArray(propertyMonthlyLedger.contractId, sharedContractIds));

            const sharedLedgerByContract = new Map<number, typeof sharedLedgerRows>();
            for (const row of sharedLedgerRows) {
              const arr = sharedLedgerByContract.get(row.contractId) ?? [];
              arr.push(row);
              sharedLedgerByContract.set(row.contractId, arr);
            }
            for (const c of sharedContracts) {
              const billingDay = getRentalBillingDay(c.startDate as string);
              const rows = sharedLedgerByContract.get(c.id) ?? [];
              const expected = sumMoney(
                rows
                  .filter((row) => getRentalPeriodDueDate(row.year, row.month, billingDay) <= asOf)
                  .map((row) => row.expectedAmount as string)
              );
              // Will set outstanding after loading paid
              sharedExpected.set(c.id, expected.toNumber());
              sharedOutstanding.set(c.id, expected.toNumber());
            }

            // POSTED rent payments for shared contracts — exclude guarantee deposits/releases.
            const { rows: sharedPostedRows } = await pool.query<{ contract_id: string; paid: string }>(
              `SELECT contract_id, COALESCE(SUM(amount::numeric), 0) AS paid
               FROM property_payments
               WHERE contract_id = ANY($1) AND posting_status = 'POSTED' AND payment_date <= $2
                 AND ledger_row_id IS NOT NULL
               GROUP BY contract_id`,
              [sharedContractIds, asOf]
            );
            sharedPostedRows.forEach((r) => sharedPaid.set(parseInt(r.contract_id), toMoney(r.paid).toNumber()));

            // SCHEDULED for shared
            const { rows: sharedSchedRows } = await pool.query<{ contract_id: string; scheduled: string }>(
              `SELECT contract_id, COALESCE(SUM(amount::numeric), 0) AS scheduled
               FROM property_payments
               WHERE contract_id = ANY($1) AND posting_status = 'SCHEDULED'
               GROUP BY contract_id`,
              [sharedContractIds]
            );
            sharedSchedRows.forEach((r) =>
              sharedScheduled.set(parseInt(r.contract_id), toMoney(r.scheduled).toNumber())
            );

            // Finalize outstanding = expected - paid
            for (const c of sharedContracts) {
              const expected = sharedExpected.get(c.id) ?? 0;
              const paid = sharedPaid.get(c.id) ?? 0;
              sharedOutstanding.set(c.id, toMoney(expected).minus(paid).toNumber());
            }

            // Fetch owner company names
            const ownerCompanyIds = [...new Set(sharedContracts.map((c) => c.companyId))];
            const ownerCompanies = await db
              .select({ id: companies.id, name: companies.name })
              .from(companies)
              .where(inArray(companies.id, ownerCompanyIds));
            const ownerNameMap = new Map(ownerCompanies.map((c) => [c.id, c.name]));

            // Sum [Guarantee applied] payments for shared contracts
            const sharedGuaranteeApplied = new Map<number, number>();
            const sharedAppliedRows = await db
              .select({
                contractId: propertyPayments.contractId,
                total: sql<string>`COALESCE(SUM(${propertyPayments.amount}), 0)`,
              })
              .from(propertyPayments)
              .where(
                and(
                  inArray(propertyPayments.contractId, sharedContractIds),
                  sql`${propertyPayments.notes} LIKE '%[Guarantee applied]%'`
                )
              )
              .groupBy(propertyPayments.contractId);
            sharedAppliedRows.forEach((r) => sharedGuaranteeApplied.set(r.contractId, Number(r.total)));

            sharedResults = sharedContracts
              .map((c) => {
                const u = sharedUnitMap.get(c.unitId);
                if (!u) return null;
                const appliedAsRent = sharedGuaranteeApplied.get(c.id) ?? 0;
                const guaranteeRemaining = Math.max(0, toMoney(c.guaranteeAmount).minus(appliedAsRent).toNumber());
                // FIX #8: separate non-negative outstanding and credit fields for shared contracts
                const rawOutstanding = sharedOutstanding.get(c.id) ?? 0;
                const expectedAsOf = sharedExpected.get(c.id) ?? 0;
                const paidAsOf = sharedPaid.get(c.id) ?? 0;
                const scheduledAmount = sharedScheduled.get(c.id) ?? 0;
                const outstanding = Math.max(0, rawOutstanding);
                const prepaidCredit = rawOutstanding < 0 ? Math.abs(rawOutstanding) : null;
                const billingDay = getRentalBillingDay(c.startDate as string);
                const nextBillingDate = computeNextBillingDate(billingDay, asOf);
                return {
                  ...u,
                  contract: c,
                  expectedAsOf,
                  outstanding,
                  paidAsOf,
                  totalPaid: paidAsOf,
                  scheduledAmount,
                  prepaidCredit,
                  billingDay,
                  nextBillingDate,
                  guaranteeRemaining,
                  isShared: true,
                  ownerCompanyName: ownerNameMap.get(c.companyId) ?? null,
                };
              })
              .filter(Boolean) as typeof ownedResults;
          }
        } // end if (unitType === "SHOP")
      } catch (sharedErr: unknown) {
        // Column may not exist yet in production — owned units still load fine
        logger.warn(`${tag} shared-units skipped:`, { error: getErrorMessage(sharedErr).split("\n")[0] });
      }

      res.json([...ownedResults, ...sharedResults]);
    } catch (e: unknown) {
      logger.error(`${tag} units:`, { error: e });
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });
}
