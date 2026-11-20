/**
 * Request schemas for the Supplier Partner migration and cutover write routes
 * (spMigrationPhase2Routes.ts, spMigrationCutoverRoutes.ts,
 * spMigrationPhase4Routes.ts).
 *
 * Migration paths are outside the Phase 5 voucher-path boundary, so they take
 * the access-control fields but no `clientRequestId`.
 */
import { z } from "zod";
import { stringParam, type RequestSchemas } from "../../lib/validateRequest";
import { amountish, numberish, spGuardFields } from "./spRequestSchemas";

/** Read by validateMigrationPair (spMigrationPhase2Common.ts). */
const migrationPairFields = {
  sourceCompanyId: numberish.nullable().optional(),
  targetCompanyId: numberish.nullable().optional(),
};

/** Compared by validateMigrationPair / exactCutoverConfirmation. */
const companyNameConfirm = z.string().optional();

/** Read by phase4WriteGuard for migration writes outside the cutover controls. */
const runId = numberish.nullable().optional();

const importInput = {
  body: z.strictObject({ ...spGuardFields, ...migrationPairFields, companyNameConfirm, runId }),
} satisfies RequestSchemas;

export const importHistoricalSalesInput = importInput;
export const importContainersInput = importInput;

export const rollbackMigrationRunInput = {
  body: z.strictObject({ ...spGuardFields, runId }),
} satisfies RequestSchemas;

const mappingBody = z.strictObject({
  ...spGuardFields,
  ...migrationPairFields,
  targetLedgerAccountId: numberish.nullable().optional(),
});

export const mapSuspenseEntryInput = {
  params: z.strictObject({ targetEntryId: stringParam }),
  body: mappingBody,
} satisfies RequestSchemas;

export const mapContainerChargeInput = {
  params: z.strictObject({ chargeId: stringParam }),
  body: mappingBody,
} satisfies RequestSchemas;

const prepareFields = {
  ...spGuardFields,
  ...migrationPairFields,
  companyNameConfirm,
  rollbackWindowHours: amountish.nullable().optional(),
  notes: z.string().nullable().optional(),
};

const cutoverIdFields = {
  ...spGuardFields,
  cutoverId: numberish.nullable().optional(),
  companyNameConfirm,
};

export const prepareCutoverInput = { body: z.strictObject(prepareFields) } satisfies RequestSchemas;

export const finalizeCutoverInput = {
  body: z.strictObject({ ...spGuardFields, ...migrationPairFields, companyNameConfirm }),
} satisfies RequestSchemas;

/** rollback, cancel and release-target-hold: each reads cutoverId and the confirmations. */
export const cutoverByIdInput = { body: z.strictObject(cutoverIdFields) } satisfies RequestSchemas;

/** POST /api/sp/migration/cutover dispatches on `action` to any of the handlers above. */
export const cutoverActionInput = {
  body: z.strictObject({
    ...prepareFields,
    ...cutoverIdFields,
    action: z.string().nullable().optional(),
  }),
} satisfies RequestSchemas;
