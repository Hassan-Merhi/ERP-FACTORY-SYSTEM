import { z } from "zod";
import { emptyQuery, type RequestSchemas } from "../../lib/validateRequest";

// positiveInt()/idArray() run Number(...) on each id and keep their own 400
// answers; client/src/pages/useAccountMigrationState.ts sends parseInt(...),
// which is null in JSON when nothing is selected.
const looseId = z.union([z.number(), z.string()]);
const looseCompanyId = looseId.nullable().optional();

export const executeAccountMigrationInput = {
  query: emptyQuery,
  body: z.strictObject({
    accountIds: z.array(looseId.nullable()).optional(),
    srcCompanyId: looseCompanyId,
    destCompanyId: looseCompanyId,
  }),
} satisfies RequestSchemas;

// Shared by the three registrations of the undo path (round-trip, safe undo,
// legacy import-export undo).
export const undoAccountMigrationInput = {
  query: emptyQuery,
  body: z.strictObject({
    accounts: z
      .array(
        z.strictObject({
          accountId: looseId.nullable().optional(),
          originalCode: z.string().nullable().optional(),
          // The execute response's account rows carry these too; callers that
          // pass them back unchanged (tests/phase33b-account-migration-routes.test.ts)
          // keep working. Not used.
          accountName: z.unknown().optional(),
          finalCode: z.unknown().optional(),
          entryCount: z.unknown().optional(),
          wasRenamed: z.unknown().optional(),
        })
      )
      .optional(),
    movedVoucherIds: z.array(looseId.nullable()).nullable().optional(),
    srcCompanyId: looseCompanyId,
    destCompanyId: looseCompanyId,
  }),
} satisfies RequestSchemas;
