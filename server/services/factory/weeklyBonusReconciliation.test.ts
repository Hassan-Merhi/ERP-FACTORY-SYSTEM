import {describe,expect,it} from "vitest";
import {reconcileWeeklyBonusLedger,type WeeklyBonusLedgerRow} from "./weeklyBonusReconciliation";

const good:WeeklyBonusLedgerRow={
  paymentId:1,companyId:6,workerId:42,weekStart:"2026-10-26",weekEnd:"2026-11-01",
  amount:"15.00",status:"POSTED",paymentDate:"2026-11-02",
  cashAccountId:10,expenseAccountId:11,voucherId:77,reversalVoucherId:null,
  reviewId:5,reviewWorkerId:42,reviewWeekStart:"2026-10-26",reviewWeekEnd:"2026-11-01",
  reviewStatus:"approved",reviewAmount:"15.00",
  expenseCode:"PAYROLL_DEPOSIT_EXPENSE",expenseCompanyId:6,cashType:"Cash",cashCompanyId:6,
  voucherCompanyId:6,voucherType:"Payment",voucherCurrency:"USD",
  voucherDate:"2026-11-02",voucherDeleted:false,
  paymentExpenseDebit:"15.00",paymentExpenseCredit:"0.00",paymentCashDebit:"0.00",
  paymentCashCredit:"15.00",paymentTotalDebit:"15.00",paymentTotalCredit:"15.00",
  paymentLines:2,paymentDaybookCount:1,paymentDaybookUsd:"15.00",paymentDaybookNative:"15.00",
  reversalCompanyId:null,reversalType:null,reversalCurrency:null,reversalDate:null,reversalDeleted:false,
  reversalExpenseDebit:"0",reversalExpenseCredit:"0",reversalCashDebit:"0",reversalCashCredit:"0",
  reversalTotalDebit:"0",reversalTotalCredit:"0",reversalLines:0,
  reversalDaybookCount:0,reversalDaybookUsd:"0",reversalDaybookNative:"0",
};
describe("Phase 16 weekly Deposit Expense and Cash/Bank reconciliation",()=>{
  it("passes a balanced approved payment and one Daybook claim",()=>{
    expect(reconcileWeeklyBonusLedger(good)).toMatchObject({paymentId:1,reconciled:true,issues:[]});
  });
  it("detects account, tenant and signed voucher inconsistencies",()=>{
    expect(reconcileWeeklyBonusLedger({...good,cashCompanyId:7}).issues).toContain("ACCOUNT_MISMATCH");
    expect(reconcileWeeklyBonusLedger({...good,voucherCompanyId:7}).issues).toContain("PAYMENT_VOUCHER_MISMATCH");
    expect(reconcileWeeklyBonusLedger({...good,paymentExpenseDebit:"14.00"}).issues)
      .toContain("PAYMENT_LINES_MISMATCH");
    expect(reconcileWeeklyBonusLedger({...good,paymentDaybookCount:2}).issues)
      .toContain("PAYMENT_DAYBOOK_MISMATCH");
    expect(reconcileWeeklyBonusLedger({...good,reviewStatus:"rejected"}).issues)
      .toContain("REVIEW_MISMATCH");
  });
  it("reconciles a reversed payment with exact Receipt and negative Daybook",()=>{
    const reversed:WeeklyBonusLedgerRow={...good,status:"REVERSED",reversalVoucherId:81,
      reversalCompanyId:6,reversalType:"Receipt",reversalCurrency:"USD",
      reversalDate:"2026-11-03",reversalDeleted:false,
      reversalExpenseDebit:"0",reversalExpenseCredit:"15.00",
      reversalCashDebit:"15.00",reversalCashCredit:"0",
      reversalTotalDebit:"15.00",reversalTotalCredit:"15.00",
      reversalLines:2,reversalDaybookCount:1,reversalDaybookUsd:"-15.00",
      reversalDaybookNative:"-15.00"};
    expect(reconcileWeeklyBonusLedger(reversed).reconciled).toBe(true);
    expect(reconcileWeeklyBonusLedger({...reversed,reversalDaybookUsd:"15.00"}).issues)
      .toContain("REVERSAL_DAYBOOK_MISMATCH");
    expect(reconcileWeeklyBonusLedger({...reversed,reversalExpenseCredit:"0.00"}).issues)
      .toContain("REVERSAL_LINES_MISMATCH");
    expect(reconcileWeeklyBonusLedger({...reversed,reversalVoucherId:null}).issues)
      .toContain("REVERSAL_VOUCHER_MISMATCH");
  });
});
