import fs from "node:fs";

const required = [
  "server/routes/erp-payroll",
  "server/services/accounting/employeeBalancePosting.ts",
  "server/routes/vouchers/centralPaymentReceiptDeleteRoute.ts",
  "docs/archive/program-2-phase-7-payroll.md",
];
for (const file of required) if (!fs.existsSync(file)) throw new Error(`Program 2 Phase 7 missing: ${file}`);
// Split into a directory during the god-file cleanup: assert over every source file in it.
const readModule = (dir) =>
  fs
    .readdirSync(dir, { recursive: true })
    .filter((file) => String(file).endsWith(".ts") && !String(file).endsWith(".test.ts"))
    .map((file) => fs.readFileSync(`${dir}/${file}`, "utf8"))
    .join("\n");
const payroll = readModule(required[0]);
const employee = fs.readFileSync(required[1], "utf8");
const deletion = fs.readFileSync(required[2], "utf8");
const doc = fs.readFileSync(required[3], "utf8");
const checks = [
  [payroll.includes('/api/payroll/deposit-employee'), "single salary deposit route must remain"],
  [payroll.includes('/api/payroll/bulk-deposit-employees'), "bulk salary deposit route must remain"],
  [payroll.includes('/api/payroll/bonus-employee'), "employee bonus route must remain"],
  [payroll.includes('/api/payroll/withdraw-employee'), "salary withdrawal route must remain"],
  [payroll.includes('/api/payroll/pay-worker'), "worker direct-payment route must remain"],
  [payroll.includes("erpPayrollRuns") && payroll.includes("erpPayrollRunItems"), "payroll-run lifecycle tables must remain used"],
  [payroll.includes("salaryAdvances") && payroll.includes("salaryAdvanceDeductions"), "advance and deduction workflows must remain isolated"],
  [payroll.includes("syncEmployeeBalancesFromEntries"), "employee balances must continue deriving from voucher entries"],
  [payroll.includes("SAL-DEP-") && payroll.includes("SAL-WD-"), "payroll voucher identity prefixes must remain"],
  [payroll.includes("SALARY_EXPENSE") && payroll.includes("BONUS_EXPENSE"), "salary and bonus expense mappings must remain"],
  [employee.includes('EmployeeBalancePostingDirection = "apply" | "reverse"') || employee.includes("direction: \"reverse\"") || employee.includes('direction?: "apply" | "reverse"'), "employee posting must preserve reverse support"],
  [deletion.includes("voucherNumber") && deletion.includes("salesItemCount"), "generic deletion policy must retain specialized-voucher classification inputs"],
  [doc.includes("Status: complete"), "Phase 7 documentation must remain complete"],
  [doc.includes("No historical payroll record is repaired automatically"), "historical payroll safety must remain documented"],
];
for (const [ok, message] of checks) if (!ok) throw new Error(`Program 2 Phase 7 verification failed: ${message}`);
console.log("Program 2 Phase 7 payroll contract verified.");