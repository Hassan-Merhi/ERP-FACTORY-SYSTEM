// Extracted from ./registerFactoryPressingReportRoutes.ts: request schemas for its write routes.
import { z } from "zod";
import { pressingSavedViewSchema } from "@shared/pressingReportContracts";
import { emptyBody, emptyQuery, stringIdParams, type RequestSchemas } from "../../lib/validateRequest";
import { pressingTargetKgSchema, pressingWeeklyScheduleInputSchema } from "./pressingHourlyTargetRules";

const pressingCalendarDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (date) =>
      !Number.isNaN(Date.parse(date + "T00:00:00Z")) &&
      new Date(date + "T00:00:00Z").toISOString().slice(0, 10) === date
  );

/**
 * Body of PUT …/hourly-targets: either one date-scoped hourly target
 * (client/src/pages/factory/PressingHourlyTargets.tsx) or a legacy per-worker target.
 */
export const pressingHourlyTargetBodySchema = z.union([
  z.strictObject({
    day: pressingCalendarDay,
    hour: z.number().int().min(7).max(16),
    targetKgPerHour: pressingTargetKgSchema,
  }),
  z.strictObject({
    userId: z.string().trim().min(1).max(255),
    targetKgPerHour: pressingTargetKgSchema,
  }),
]);

export const hourlyTargetInput = { query: emptyQuery, body: pressingHourlyTargetBodySchema } satisfies RequestSchemas;

// client/src/pages/factory/PressingHourlyTargets.tsx sends { weekday, targetsKg }.
export const dailyScheduleInput = {
  query: emptyQuery,
  body: pressingWeeklyScheduleInputSchema,
} satisfies RequestSchemas;

export const saveView = { query: emptyQuery, body: pressingSavedViewSchema } satisfies RequestSchemas;

export const removeViewInput = { params: stringIdParams, query: emptyQuery, body: emptyBody } satisfies RequestSchemas;
