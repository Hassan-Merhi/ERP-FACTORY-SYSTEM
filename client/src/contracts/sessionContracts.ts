import { z, type ZodType } from "zod";

export const companyTypeSchema = z.enum(["erp", "factory", "factory_v2", "properties", "supplier_partner", "retail"]);

export type CompanyType = z.infer<typeof companyTypeSchema>;

const optionalPositiveInteger = z.coerce.number().int().positive().nullable().optional();
const optionalNonNegativeInteger = z.coerce.number().int().nonnegative().nullable().optional();
const optionalBoolean = z.boolean().nullable().optional();

export class SessionContractError extends Error {
  constructor(
    public readonly contract: "authenticated-user" | "user-companies" | "session-company",
    public readonly issues: readonly string[]
  ) {
    super(`Invalid ${contract} response`);
    this.name = "SessionContractError";
  }
}

function parseContract<T>(contract: SessionContractError["contract"], schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new SessionContractError(
    contract,
    parsed.error.issues.map((issue) => `${issue.path.join(".") || "response"}: ${issue.message}`)
  );
}

export const authenticatedUserSchema = z
  .object({
    id: z.union([z.string().min(1), z.number().int()]),
    username: z.string().min(1),
    role: z.string().min(1).nullable().optional(),
    currentRole: z.string().min(1).nullable().optional(),
    currentCompanyId: optionalPositiveInteger,
    currentLocationId: optionalPositiveInteger,
    currentPOSStation: optionalPositiveInteger,
    active: z.boolean().optional(),
    assignedLocationId: optionalPositiveInteger,
    posStation: z
      .union([
        z.string().min(1),
        z
          .number()
          .int()
          .transform((value) => String(value)),
      ])
      .nullable()
      .optional(),
    cashAccountId: optionalPositiveInteger,
    canSellNegativeStock: optionalBoolean,
    posViewOnly: optionalBoolean,
    daybookEditDays: optionalNonNegativeInteger,
    canAccessCustomers: optionalBoolean,
    canDeleteRecords: optionalBoolean,
  })
  .passthrough();

export type AuthenticatedUser = z.infer<typeof authenticatedUserSchema>;

export const userCompanyAssignmentSchema = z
  .object({
    companyId: z.coerce.number().int().positive(),
    companyCode: z.string().default(""),
    companyName: z.string().min(1),
    companyActive: z.boolean().default(true),
    role: z.string().min(1).optional(),
    companyType: companyTypeSchema.catch("erp"),
    displayCurrency: z.string().nullable().optional(),
    assignedLocationId: optionalPositiveInteger,
    posStation: optionalPositiveInteger,
    cashAccountId: optionalPositiveInteger,
    canSellNegativeStock: optionalBoolean,
    posViewOnly: optionalBoolean,
    daybookEditDays: optionalNonNegativeInteger,
    canAccessCustomers: optionalBoolean,
    canDeleteRecords: optionalBoolean,
  })
  .passthrough();

export type UserCompanyAssignment = z.infer<typeof userCompanyAssignmentSchema>;

export const userCompaniesResponseSchema = z.array(userCompanyAssignmentSchema);

export const sessionCompanyResponseSchema = z.object({
  companyId: z.coerce.number().int().positive().nullable(),
});

export type SessionCompanyResponse = z.infer<typeof sessionCompanyResponseSchema>;

export function parseAuthenticatedUser(value: unknown): AuthenticatedUser | null {
  if (value === null || value === undefined) return null;
  return parseContract("authenticated-user", authenticatedUserSchema, value);
}

export function parseUserCompanies(value: unknown): UserCompanyAssignment[] {
  return parseContract("user-companies", userCompaniesResponseSchema, value);
}

export function parseSessionCompany(value: unknown): SessionCompanyResponse {
  return parseContract("session-company", sessionCompanyResponseSchema, value);
}
