import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { requireFactoryTabAccess } from "../../lib/factoryAccessControl";
import { resultRows } from "../../lib/queryResult";
import { logger } from "../../lib/logger";
import { isRealBonusDate } from "../../services/factory/targetBonusPaymentPolicy";
import { reconcileWeeklyBonusLedger, type WeeklyBonusLedgerRow } from "../../services/factory/weeklyBonusReconciliation";

const guard=requireFactoryTabAccess("factory/stock-entry","hide_tab_stockentry_production_targets");
/** Read-only exception report. Does not create vouchers, fix rows or reopen claims. */
export function registerProductionTargetBonusWeeklyReconciliationRoutes(app:Express):void {
  app.get("/api/factory/production-target-bonuses/weekly-reconciliation",
    requireAuth,guard,async(req:Request,res:Response)=>{
      if(!["Admin","Owner"].includes(String(req.session.currentRole||req.user?.role||"")))
        return res.status(403).json({message:"Admin or Owner required"});
      const companyId=Number(req.session.factoryCompanyId||req.session.currentCompanyId);
      if(!Number.isSafeInteger(companyId)||companyId<=0)
        return res.status(400).json({message:"Factory company required"});
      const start=req.query.start,end=req.query.end;
      if(!isRealBonusDate(start)||!isRealBonusDate(end)||start>end||
         (Date.parse(end)-Date.parse(start))/86400000>366)
        return res.status(400).json({message:"Choose up to 366 valid days"});
      try {
        const result=await db.execute(sql`
          SELECT p.id AS "paymentId", p.company_id AS "companyId",
            p.worker_id AS "workerId", p.week_start::text AS "weekStart",
            p.week_end::text AS "weekEnd", p.bonus_amount::text AS amount,
            p.status, p.payment_date::text AS "paymentDate",
            p.cash_ledger_account_id AS "cashAccountId",
            p.expense_ledger_account_id AS "expenseAccountId",
            p.payment_voucher_id AS "voucherId",
            p.reversal_voucher_id AS "reversalVoucherId",
            rv.id AS "reviewId", rv.worker_id AS "reviewWorkerId",
            rv.week_start::text AS "reviewWeekStart",
            rv.week_end::text AS "reviewWeekEnd",
            rv.status AS "reviewStatus",rv.bonus_amount::text AS "reviewAmount",
            ea.code AS "expenseCode",ea.company_id AS "expenseCompanyId",
            ca.account_type AS "cashType",ca.company_id AS "cashCompanyId",
            v.company_id AS "voucherCompanyId",v.voucher_type AS "voucherType",
            v.currency AS "voucherCurrency",v.voucher_date::text AS "voucherDate",
            v.deleted_at IS NOT NULL AS "voucherDeleted",
            COALESCE(ve.expense_debit,0)::text AS "paymentExpenseDebit",
            COALESCE(ve.expense_credit,0)::text AS "paymentExpenseCredit",
            COALESCE(ve.cash_debit,0)::text AS "paymentCashDebit",
            COALESCE(ve.cash_credit,0)::text AS "paymentCashCredit",
            COALESCE(ve.total_debit,0)::text AS "paymentTotalDebit",
            COALESCE(ve.total_credit,0)::text AS "paymentTotalCredit",
            COALESCE(ve.lines,0)::integer AS "paymentLines",
            COALESCE(pd.entries,0)::integer AS "paymentDaybookCount",
            COALESCE(pd.usd,0)::text AS "paymentDaybookUsd",
            COALESCE(pd.native,0)::text AS "paymentDaybookNative",
            rev.company_id AS "reversalCompanyId",rev.voucher_type AS "reversalType",
            rev.currency AS "reversalCurrency",
            rev.voucher_date::text AS "reversalDate",
            rev.deleted_at IS NOT NULL AS "reversalDeleted",
            COALESCE(re.expense_debit,0)::text AS "reversalExpenseDebit",
            COALESCE(re.expense_credit,0)::text AS "reversalExpenseCredit",
            COALESCE(re.cash_debit,0)::text AS "reversalCashDebit",
            COALESCE(re.cash_credit,0)::text AS "reversalCashCredit",
            COALESCE(re.total_debit,0)::text AS "reversalTotalDebit",
            COALESCE(re.total_credit,0)::text AS "reversalTotalCredit",
            COALESCE(re.lines,0)::integer AS "reversalLines",
            COALESCE(rd.entries,0)::integer AS "reversalDaybookCount",
            COALESCE(rd.usd,0)::text AS "reversalDaybookUsd",
            COALESCE(rd.native,0)::text AS "reversalDaybookNative"
          FROM factory_target_bonus_weekly_payments p
          LEFT JOIN factory_target_bonus_weekly_reviews rv
            ON rv.id=p.review_id AND rv.company_id=p.company_id
          LEFT JOIN ledger_accounts ca ON ca.id=p.cash_ledger_account_id
          LEFT JOIN ledger_accounts ea ON ea.id=p.expense_ledger_account_id
          LEFT JOIN vouchers v ON v.id=p.payment_voucher_id
          LEFT JOIN vouchers rev ON rev.id=p.reversal_voucher_id
          LEFT JOIN LATERAL (
            SELECT COUNT(*) AS lines,
              SUM(COALESCE(e.debit_amount,0)) AS total_debit,
              SUM(COALESCE(e.credit_amount,0)) AS total_credit,
              SUM(CASE WHEN e.ledger_account_id=p.expense_ledger_account_id THEN COALESCE(e.debit_amount,0) ELSE 0 END) AS expense_debit,
              SUM(CASE WHEN e.ledger_account_id=p.expense_ledger_account_id THEN COALESCE(e.credit_amount,0) ELSE 0 END) AS expense_credit,
              SUM(CASE WHEN e.ledger_account_id=p.cash_ledger_account_id THEN COALESCE(e.debit_amount,0) ELSE 0 END) AS cash_debit,
              SUM(CASE WHEN e.ledger_account_id=p.cash_ledger_account_id THEN COALESCE(e.credit_amount,0) ELSE 0 END) AS cash_credit
            FROM voucher_entries e WHERE e.voucher_id=p.payment_voucher_id
          ) ve ON TRUE
          LEFT JOIN LATERAL (
            SELECT COUNT(*) AS lines,
              SUM(COALESCE(e.debit_amount,0)) AS total_debit,
              SUM(COALESCE(e.credit_amount,0)) AS total_credit,
              SUM(CASE WHEN e.ledger_account_id=p.expense_ledger_account_id THEN COALESCE(e.debit_amount,0) ELSE 0 END) AS expense_debit,
              SUM(CASE WHEN e.ledger_account_id=p.expense_ledger_account_id THEN COALESCE(e.credit_amount,0) ELSE 0 END) AS expense_credit,
              SUM(CASE WHEN e.ledger_account_id=p.cash_ledger_account_id THEN COALESCE(e.debit_amount,0) ELSE 0 END) AS cash_debit,
              SUM(CASE WHEN e.ledger_account_id=p.cash_ledger_account_id THEN COALESCE(e.credit_amount,0) ELSE 0 END) AS cash_credit
            FROM voucher_entries e WHERE e.voucher_id=p.reversal_voucher_id
          ) re ON TRUE
          LEFT JOIN LATERAL (
            SELECT COUNT(*) AS entries,
              SUM(d.amount_usd) AS usd,SUM(d.amount_currency) AS native
            FROM factory_daybook_entries d
            WHERE d.company_id=p.company_id
              AND d.reference_table='factory_target_bonus_weekly_payments'
              AND d.reference_id=p.id
              AND d.tx_type='PRODUCTION_TARGET_WEEKLY_BONUS_PAYMENT'
          ) pd ON TRUE
          LEFT JOIN LATERAL (
            SELECT COUNT(*) AS entries,
              SUM(d.amount_usd) AS usd,SUM(d.amount_currency) AS native
            FROM factory_daybook_entries d
            WHERE d.company_id=p.company_id
              AND d.reference_table='factory_target_bonus_weekly_payments'
              AND d.reference_id=p.id
              AND d.tx_type='PRODUCTION_TARGET_WEEKLY_BONUS_REVERSAL'
          ) rd ON TRUE
          WHERE p.company_id=${companyId}
            AND p.week_start BETWEEN ${start}::date AND ${end}::date
          ORDER BY p.week_start DESC,p.id
          LIMIT 3001
        `);
        const payments=resultRows(result) as unknown as WeeklyBonusLedgerRow[];
        if(payments.length>3000)return res.status(413).json({message:"Narrow the reconciliation date range"});
        const audits=payments.map(reconcileWeeklyBonusLedger);
        const discrepancies=audits.filter(row=>!row.reconciled);
        res.setHeader("Cache-Control","private, no-store");
        return res.json({start,end,companyId,paymentCount:audits.length,
          passed:audits.length-discrepancies.length,failed:discrepancies.length,
          financiallyCertified:discrepancies.length===0 && audits.length>0,
          audits,discrepancies,
          note:"Read-only consistency check. Production certification also requires CI, concurrent posting and PostgreSQL integration tests."});
      }catch(error){
        logger.error("Weekly bonus accounting reconciliation failed",{error});
        return res.status(500).json({message:"Weekly bonus reconciliation could not be completed"});
      }
    });
}
