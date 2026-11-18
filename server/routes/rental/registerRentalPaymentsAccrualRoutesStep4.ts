// Extracted from ./rentalPaymentsAccrualRoutes.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { ensureMonthlyForCompany, getCompanyId, type RentalModule } from "./shared";
import { companyBusinessDate } from "../../services/accounting/companyBusinessDate";
import { runInCompanyPostingScope } from "../../services/accounting/scheduledPostingScope";
import { db } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { ledgerAccounts, propertyContracts, propertyPayments, propertyUnits } from "@shared/schema";
import { getClientDate } from "../../lib/dateUtils";
import { isPropertiesReceiptAccountType } from "../../services/rental/rentalCashboxPolicy";
import { registerRentalPaymentsAccrualRoutesStep1 } from "./registerRentalPaymentsAccrualRoutesStep1";

export function registerRentalPaymentsAccrualRoutesStep4(
  { tag }: Pick<Awaited<ReturnType<typeof registerRentalPaymentsAccrualRoutesStep1>>, "tag">,
  app: Express,
  module: RentalModule,
  urlPrefix: string
) {
  // ── CASH ACCOUNTS picker ──
  app.get(`${urlPrefix}/cash-accounts`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const accts = await db
        .select()
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.companyId, companyId),
            eq(ledgerAccounts.active, true),
            isNull(ledgerAccounts.deletedAt)
          )
        );
      const receiptAccounts =
        module === "PROPERTIES" ? accts.filter((a) => isPropertiesReceiptAccountType(a.accountType)) : accts;
      res.json(receiptAccounts.sort((a, b) => a.name.localeCompare(b.name)));
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── GLOBAL PAYMENTS LOG ──
  app.get(`${urlPrefix}/payments`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const statusFilter = req.query.status as string | undefined;
      // This is exclusively a read-side reporting view. Payments are still posted,
      // owned, and deleted using their original module, company, and vouchers.
      // Warehouse Total Paid aggregates by ACTIVE contract rather than payment
      // module; the normal Properties log previously omitted ERP-module rent.
      const warehouseReconciliation = module === "PROPERTIES" && req.query.view === "warehouse-reconciliation";
      const conditions = warehouseReconciliation
        ? [
            eq(propertyPayments.companyId, companyId),
            eq(propertyContracts.companyId, companyId),
            eq(propertyContracts.module, "PROPERTIES"),
            eq(propertyUnits.companyId, companyId),
            eq(propertyUnits.module, "PROPERTIES"),
            eq(propertyUnits.unitType, "WAREHOUSE"),
            eq(propertyUnits.active, true),
          ]
        : [eq(propertyPayments.companyId, companyId), eq(propertyPayments.module, module)];
      if (statusFilter) {
        conditions.push(sql`${propertyPayments.postingStatus} = ${statusFilter}`);
      }
      const asOf = getClientDate(req);

      const payments = await db
        .select({
          id: propertyPayments.id,
          paymentDate: propertyPayments.paymentDate,
          amount: propertyPayments.amount,
          forYear: propertyPayments.forYear,
          forMonth: propertyPayments.forMonth,
          notes: propertyPayments.notes,
          contractId: propertyPayments.contractId,
          unitId: propertyPayments.unitId,
          currency: propertyPayments.currency,
          exchangeRate: propertyPayments.exchangeRate,
          cashAccountId: propertyPayments.cashAccountId,
          voucherId: propertyPayments.voucherId,
          postingStatus: propertyPayments.postingStatus,
          paymentGroupId: propertyPayments.paymentGroupId,
          postedAt: propertyPayments.postedAt,
          sourceModule: propertyPayments.module,
          contractStatus: propertyContracts.status,
          ledgerRowId: propertyPayments.ledgerRowId,
          reconciliationCategory: sql<string>`CASE
            WHEN ${propertyPayments.postingStatus} = 'SCHEDULED'
              OR ${propertyPayments.paymentDate} > ${asOf} THEN 'SCHEDULED'
            WHEN ${propertyPayments.ledgerRowId} IS NULL THEN 'GUARANTEE'
            WHEN ${propertyContracts.status} = 'ENDED' THEN 'ENDED_RENT'
            WHEN ${propertyContracts.status} = 'ACTIVE'
              AND ${propertyPayments.postingStatus} = 'POSTED'
              AND ${propertyPayments.ledgerRowId} IS NOT NULL THEN 'ACTIVE_RENT'
            ELSE 'OTHER'
          END`,
          tenantName: propertyContracts.tenantName,
          unitNumber: propertyUnits.unitNumber,
          locationGroup: propertyUnits.locationGroup,
        })
        .from(propertyPayments)
        .leftJoin(propertyContracts, eq(propertyContracts.id, propertyPayments.contractId))
        .leftJoin(propertyUnits, eq(propertyUnits.id, propertyPayments.unitId))
        .where(and(...conditions))
        .orderBy(desc(propertyPayments.paymentDate));

      // Guarantee-to-statement creates a balanced Receipt voucher (Dr cash,
      // Cr Tenant Deposits) but intentionally does not insert a property_payments
      // record. Include those real receipts only in the warehouse reconciliation
      // read model, never by inserting/backfilling a payment or journal.
      //
      // Read-only negative IDs cannot collide with property_payments IDs.
      // Restrict to the GUAR-{sequence}-{contractId} family, its matching
      // Properties contract and warehouse, and both posted voucher legs.
      // Exclude voucher IDs already represented in property_payments.
      let combinedPayments: Array<Record<string, unknown>> = payments;
      if (warehouseReconciliation && (!statusFilter || statusFilter === "POSTED")) {
        const receiptResult = await db.execute(sql`
          WITH guarantee_vouchers AS MATERIALIZED (
            SELECT id, company_id, voucher_date, voucher_number, currency
            FROM vouchers
            WHERE company_id = ${companyId}
              AND deleted_at IS NULL
              AND optional = FALSE
              AND voucher_type = 'Receipt'
              AND voucher_number ~ ('^GUAR-[0-9]+-[0-9]+' || chr(36))
              AND description LIKE 'Guarantee deposit - %'
          )
          SELECT DISTINCT ON (v.id)
            -v.id::integer AS id,
            v.id::integer AS "voucherId",
            v.voucher_date::text AS "paymentDate",
            cash_line.debit_amount::text AS amount,
            EXTRACT(YEAR FROM v.voucher_date)::integer AS "forYear",
            EXTRACT(MONTH FROM v.voucher_date)::integer AS "forMonth",
            'Guarantee deposit (voucher-backed, read-only)'::text AS notes,
            contract.id::integer AS "contractId",
            unit.id::integer AS "unitId",
            COALESCE(v.currency, 'USD')::text AS currency,
            NULL::numeric AS "exchangeRate",
            cash_line.ledger_account_id::integer AS "cashAccountId",
            'POSTED'::text AS "postingStatus",
            NULL::text AS "paymentGroupId",
            NULL::timestamptz AS "postedAt",
            'PROPERTIES'::text AS "sourceModule",
            contract.status::text AS "contractStatus",
            NULL::integer AS "ledgerRowId",
            'GUARANTEE'::text AS "reconciliationCategory",
            'GUARANTEE_DEPOSIT'::text AS "receiptKind",
            TRUE AS "readOnly",
            contract.tenant_name::text AS "tenantName",
            unit.unit_number::text AS "unitNumber",
            unit.location_group::text AS "locationGroup"
          FROM guarantee_vouchers v
          JOIN property_contracts contract
            ON contract.id = split_part(v.voucher_number, '-', 3)::integer
           AND contract.company_id = v.company_id
           AND contract.module = 'PROPERTIES'
          JOIN property_units unit
            ON unit.id = contract.unit_id
           AND unit.company_id = v.company_id
           AND unit.module = 'PROPERTIES'
           AND unit.unit_type = 'WAREHOUSE'
           AND unit.active = TRUE
          JOIN voucher_entries cash_line
            ON cash_line.voucher_id = v.id
           AND cash_line.company_id = v.company_id
           AND cash_line.debit_amount > 0
          JOIN ledger_accounts cash_account
            ON cash_account.id = cash_line.ledger_account_id
           AND cash_account.company_id = v.company_id
           AND cash_account.account_type IN ('Cash', 'Bank', 'Asset')
          JOIN voucher_entries deposit_line
            ON deposit_line.voucher_id = v.id
           AND deposit_line.company_id = v.company_id
           AND deposit_line.credit_amount = cash_line.debit_amount
          JOIN ledger_accounts deposit_account
            ON deposit_account.id = deposit_line.ledger_account_id
           AND deposit_account.company_id = v.company_id
           AND deposit_account.account_type = 'Liability'
           AND deposit_account.name = 'Tenant Deposits'
          WHERE NOT EXISTS (
            SELECT 1 FROM property_payments previous
            WHERE previous.company_id = v.company_id
              AND previous.voucher_id = v.id
          )
          ORDER BY v.id, cash_line.ledger_account_id
        `);
        const receiptRows = receiptResult.rows as Array<Record<string, unknown>>;
        combinedPayments = [...payments, ...receiptRows].sort(
          (left, right) =>
            String(right.paymentDate).localeCompare(String(left.paymentDate)) || Number(right.id) - Number(left.id)
        );
      }
      res.json(combinedPayments);
    } catch (e: unknown) {
      logger.error(`${tag} payments-log:`, { error: e });
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── MANUAL MONTHLY ROLLOVER ──
  // Phase 19 (B), PE2: Admin/Owner, the company's business date, its tenant
  // scope (monthly rows only, no voucher).
  app.post(
    `${urlPrefix}/run-monthly`,
    requireAuth,
    requireRole("Admin", "Owner"),
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const asOf = await runInCompanyPostingScope(companyId, async () => {
          const businessDate = await companyBusinessDate(companyId);
          await ensureMonthlyForCompany(companyId, module, businessDate);
          return businessDate;
        });
        res.json({ ok: true, asOf });
      } catch (e: unknown) {
        res.status(500).json({ message: getErrorMessage(e) });
      }
    }
  );
  return {};
}
