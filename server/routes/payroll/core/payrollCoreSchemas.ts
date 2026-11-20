/**
 * Request schemas for the factory payroll core write routes (generate, preview,
 * mark-paid, payment summary PDF). They fix the shape of what the payroll
 * screens send; the handlers keep their own business checks and messages.
 */
import { z } from "zod";
import { emptyQuery, positiveIntParam, type RequestSchemas } from "../../../lib/validateRequest";

/** Handlers do `Number(...)`, `parseInt(...)` or `parseMoneyInput(...)` on these. */
const numberLike = z.union([z.number(), z.string()]);
const optionalNumberLike = numberLike.nullable().optional();
/** `req.body.companyId || getFactoryCompanyId(req)`: any falsy value falls back to the session. */
const bodyCompanyId = optionalNumberLike;
const periodDate = z.string().nullable().optional();
/** `{ [workerId]: amount }`; unparsable or null values fall back to the default. */
const perWorkerOverrides = z
  .record(z.string(), z.union([z.number(), z.string(), z.null()]))
  .nullable()
  .optional();
const idList = z.array(numberLike).nullable().optional();
const payrollIds = z
  .array(z.union([z.number(), z.string(), z.null()]))
  .nullable()
  .optional();
/** Read by operationalVoucherRequestBoundary and resolveFinancialOperationKey. */
const clientRequestId = z.string().optional();

const previewBodyFields = {
  companyId: bodyCompanyId,
  workerIds: idList,
  periodStart: periodDate,
  periodEnd: periodDate,
  daysCount: optionalNumberLike,
  bonusPerWorker: optionalNumberLike,
  transportOverrides: perWorkerOverrides,
};

export const payrollPreviewInput = {
  query: emptyQuery,
  body: z.strictObject(previewBodyFields),
} satisfies RequestSchemas;

export const payrollGenerateBulkInput = {
  query: emptyQuery,
  body: z.strictObject({
    ...previewBodyFields,
    cashAccountId: optionalNumberLike,
    notes: z.string().nullable().optional(),
    advanceOverrides: perWorkerOverrides,
  }),
} satisfies RequestSchemas;

const excelCell = z.number().nullable().optional();
const excelText = z.string().nullable().optional();

export const payrollPreviewExcelInput = {
  query: emptyQuery,
  body: z.strictObject({
    companyId: bodyCompanyId,
    periodStart: periodDate,
    periodEnd: periodDate,
    rows: z
      .array(
        z.strictObject({
          employeeCode: excelText,
          name: excelText,
          position: excelText,
          presentDays: excelCell,
          totalWorkingDays: excelCell,
          absentDays: excelCell,
          base: excelCell,
          bonus: excelCell,
          transportMonthly: excelCell,
          transportPaid: excelCell,
          salaryDeduction: excelCell,
          advanceDeduction: excelCell,
          net: excelCell,
        })
      )
      .nullable()
      .optional(),
  }),
} satisfies RequestSchemas;

export const payrollPaymentSummaryPdfInput = {
  query: emptyQuery,
  body: z.strictObject({ companyId: bodyCompanyId, payrollIds: idList }),
} satisfies RequestSchemas;

const payrollIdParams = z.strictObject({ id: positiveIntParam });

export const payrollMarkPaidInput = {
  params: payrollIdParams,
  query: emptyQuery,
  body: z.strictObject({
    companyId: bodyCompanyId,
    cashAccountId: optionalNumberLike,
    paymentDate: z.string().nullable().optional(),
    clientRequestId,
  }),
} satisfies RequestSchemas;

export const payrollFixAccountingInput = {
  params: payrollIdParams,
  query: emptyQuery,
  body: z.strictObject({ companyId: bodyCompanyId, cashAccountId: optionalNumberLike, clientRequestId }),
} satisfies RequestSchemas;

export const payrollMarkPaidBulkInput = {
  query: emptyQuery,
  body: z.strictObject({
    companyId: bodyCompanyId,
    payrollIds,
    cashAccountId: optionalNumberLike,
    paymentDate: z.string().nullable().optional(),
    clientRequestId,
  }),
} satisfies RequestSchemas;
