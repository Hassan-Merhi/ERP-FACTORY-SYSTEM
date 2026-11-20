/**
 * Input schemas for the screen-feed write routes in ./screenFeedRoutes.ts.
 * The validators are built here so that file stays within the 500-line cap.
 */
import { z } from "zod";
import { emptyBody, validateRequest, type RequestSchemas } from "../lib/validateRequest";

/** Every route reads `tabId` from the query string before the body. */
const tabIdQuery = z.strictObject({ tabId: z.string().optional() });

// updateRemoteSupportFlags keeps only these keys with boolean values.
const flagFields = {
  screenFeedEnabled: z.boolean().optional(),
  fastScreenFeed: z.boolean().optional(),
  remoteControl: z.boolean().optional(),
  keyboardControl: z.boolean().optional(),
  sensitiveActionProtection: z.boolean().optional(),
};

/** The handler applies `body.flags` when present, else the body itself. */
export const runtimePatchInput = {
  body: z.union([z.undefined(), z.strictObject({ ...flagFields, flags: z.strictObject(flagFields).optional() })]),
} satisfies RequestSchemas;

/** emergency-stop, restore-defaults and reset-metrics read no input. */
export const adminActionInput = { body: emptyBody } satisfies RequestSchemas;

// The cursor, failure, viewport, capture and click values are cleaned by the
// sanitizeScreenFeed* helpers, which drop what they do not recognise.
const sanitized = z.unknown().optional();

/**
 * Legacy pointer upload: `{ tabId, failure }`, `{ tabId, cursor }`, or the
 * cursor fields themselves at the top level (`req.body?.cursor ?? req.body`).
 */
export const pointerInput = {
  query: tabIdQuery,
  body: z.union([
    z.undefined(),
    z.strictObject({
      tabId: z.string().optional(),
      failure: sanitized,
      cursor: sanitized,
      x: sanitized,
      y: sanitized,
      ts: sanitized,
      visible: sanitized,
    }),
  ]),
} satisfies RequestSchemas;

/** Legacy JSON frame upload (client/src/lib/screen-feed-binary-transport.ts). */
export const frameInput = {
  query: tabIdQuery,
  body: z.union([
    z.undefined(),
    z.strictObject({
      tabId: z.string().optional(),
      dataUrl: z.string().optional(),
      clicks: sanitized,
      cursor: sanitized,
      viewport: sanitized,
      capture: sanitized,
      clientCapturedAt: sanitized,
    }),
  ]),
} satisfies RequestSchemas;

export const screenFeedValidators = {
  runtimePatch: validateRequest(runtimePatchInput),
  adminAction: validateRequest(adminActionInput),
  pointer: validateRequest(pointerInput),
  frame: validateRequest(frameInput),
};
