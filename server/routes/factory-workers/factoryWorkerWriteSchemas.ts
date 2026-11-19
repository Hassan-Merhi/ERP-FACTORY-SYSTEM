/**
 * Input schemas for the factory worker write routes (./*.ts).
 *
 * Several handlers read a body companyId before the session company. The
 * company scope stage refuses a body companyId that is not the bound company.
 */
import { z } from "zod";
import { emptyBody, emptyQuery, idParams, positiveIntParam, type RequestSchemas } from "../../lib/validateRequest";

const numberOrString = z.union([z.number(), z.string()]);
const text = z.string().nullable().optional();
// The form sends "" for an empty amount; the handlers turn it into "0".
const amount = numberOrString.nullable().optional();
const companyId = numberOrString.optional();

/**
 * Every factory_workers column a caller may set. Create re-checks the result
 * with insertFactoryWorkerSchema; update writes the fields as given, so the
 * handlers' own normalisation ("" dates to null, "" amounts to "0") still runs.
 */
const workerFields = z.strictObject({
  companyId,
  employeeCode: text,
  fullName: z.string().optional(),
  fatherName: text,
  motherName: text,
  nationalId: text,
  passportNumber: text,
  dateOfBirth: text,
  gender: text,
  nationality: text,
  maritalStatus: text,
  numberOfChildren: numberOrString.nullable().optional(),
  phone1: text,
  phone2: text,
  emergencyContactName: text,
  emergencyContactPhone: text,
  address: text,
  city: text,
  country: text,
  position: text,
  department: text,
  dateJoined: text,
  contractStartDate: text,
  contractEndDate: text,
  salaryType: z.string().optional(),
  baseSalary: amount,
  perBaleRate: amount,
  perKgRate: amount,
  overtimeRate: amount,
  shiftType: text,
  active: z.boolean().optional(),
  bankName: text,
  bankAccountNumber: text,
  paymentMethod: z.string().optional(),
  photoUrl: text,
  notes: text,
  payFrequency: z.string().optional(),
  hourlyRate: amount,
  weeklySalary: amount,
  biWeeklySalary: amount,
  transportAllowance: amount,
  visaNumber: text,
  visaExpiry: text,
  workPermitNumber: text,
  workPermitExpiry: text,
  residentialPermit: text,
  residentialPermitExpiry: text,
});

export const createFactoryWorkerInput = { query: emptyQuery, body: workerFields } satisfies RequestSchemas;

export const updateFactoryWorkerInput = {
  params: idParams,
  query: emptyQuery,
  body: workerFields,
} satisfies RequestSchemas;

/** end-contract and reactivate: the only body field read is companyId. */
export const workerContractActionInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({ companyId }),
} satisfies RequestSchemas;

export const settleAndEndWorkerInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({
    companyId,
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    hoursWorked: amount,
    dryRun: z.boolean().optional(),
    payNow: z.boolean().optional(),
    cashAccountId: numberOrString.nullable().optional(),
    skipSettlement: z.boolean().optional(),
  }),
} satisfies RequestSchemas;

/** Multipart: multer leaves the text fields in req.body as strings. */
export const workerPhotoInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({ companyId: z.string().optional() }),
} satisfies RequestSchemas;

/** Multipart with only the file part. */
export const workerDocumentUploadInput = {
  params: idParams,
  query: emptyQuery,
  body: emptyBody,
} satisfies RequestSchemas;

export const deleteWorkerDocumentInput = {
  params: z.strictObject({ id: positiveIntParam, docId: positiveIntParam }),
  query: emptyQuery,
  body: emptyBody,
} satisfies RequestSchemas;

export const importWorkersInput = { query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

export const reassignWorkerCodesInput = {
  query: emptyQuery,
  body: z.strictObject({ companyId, prefix: z.string().optional() }),
} satisfies RequestSchemas;
