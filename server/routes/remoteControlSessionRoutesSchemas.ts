/**
 * Request schemas for the remote-control (mouse) write routes in
 * remoteControlSessionRoutes.ts. They check shape only: the session and
 * command services keep their identifier, coordinate, delta, viewport and
 * status checks with their own error codes.
 */
import { z } from "zod";
import { emptyBody, emptyQuery, stringParam, type RequestSchemas } from "../lib/validateRequest";

const sessionParams = z.strictObject({ sessionId: stringParam });

/** Sent by client/src/hooks/use-remote-control-session.ts. */
export const tabHeartbeatInput = {
  query: emptyQuery,
  body: z.strictObject({ tabId: z.string().optional(), route: z.string().optional() }),
} satisfies RequestSchemas;

/** Sent by client/src/components/RemoteControlSessionWatchdog.tsx; durationMinutes goes through Number(). */
export const startSessionInput = {
  query: emptyQuery,
  body: z.strictObject({
    targetUserId: z.string().optional(),
    targetUsername: z.string().optional(),
    tabId: z.string().optional(),
    durationMinutes: z.union([z.number(), z.string()]).optional(),
  }),
} satisfies RequestSchemas;

/** Heartbeat, mouse authorization and its revoke: clients send `{}`. */
export const sessionActionInput = {
  params: sessionParams,
  query: emptyQuery,
  body: emptyBody,
} satisfies RequestSchemas;

export const mouseCommandInput = {
  params: sessionParams,
  query: emptyQuery,
  body: z.strictObject({
    type: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    deltaX: z.number().optional(),
    deltaY: z.number().optional(),
    frameViewport: z
      .strictObject({
        width: z.number(),
        height: z.number(),
        scrollX: z.number(),
        scrollY: z.number(),
        visualScale: z.number(),
      })
      .optional(),
  }),
} satisfies RequestSchemas;

export const mouseCommandResultInput = {
  params: z.strictObject({ sessionId: stringParam, commandId: stringParam }),
  query: emptyQuery,
  body: z.strictObject({
    tabId: z.string().optional(),
    status: z.string().optional(),
    reason: z.string().nullable().optional(),
  }),
} satisfies RequestSchemas;

/** Sent by use-remote-control-session.ts and RemoteControllerSessionContext.tsx. */
export const stopSessionInput = {
  params: sessionParams,
  query: emptyQuery,
  body: z.union([z.undefined(), z.strictObject({ reason: z.string().optional() })]),
} satisfies RequestSchemas;
