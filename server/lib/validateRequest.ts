/**
 * Request input validation for write routes.
 *
 * Every POST/PUT/PATCH/DELETE route declares the shape of its input with Zod
 * and mounts `validateRequest(...)` in its handler chain:
 *
 *   const createInput = {
 *     params: z.strictObject({ id: positiveIntParam }),
 *     body: insertThingSchema.strict(),
 *   } satisfies RequestSchemas;
 *
 *   app.post("/api/things/:id", requireAuth, validateRequest(createInput), async (req, res) => {
 *     const { params, body } = validatedInput(req, createInput);
 *     ...
 *   });
 *
 * The middleware is a named function, so it appears as `validateRequest` in
 * config/route-manifest.json. scripts/audit-write-validation.mjs counts a write
 * route as validated only when that name is in its chain.
 *
 * Object schemas must be strict (`z.strictObject` or `.strict()`), at every
 * depth: an unknown field is a 400, not something silently dropped or written.
 * A non-strict object schema throws when the route is registered, so the
 * mistake fails at startup and in tests, not in production traffic.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";

export interface RequestSchemas {
  body?: z.ZodType;
  params?: z.ZodType;
  query?: z.ZodType;
}

type Location = keyof RequestSchemas;
const LOCATIONS: readonly Location[] = ["params", "query", "body"];

export type ValidatedInput<S extends RequestSchemas> = {
  [K in keyof S]: S[K] extends z.ZodType ? z.output<S[K]> : never;
};

export interface RequestValidationIssue {
  location: Location;
  path: string;
  code: string;
  message: string;
}

/** The body of every 400 this middleware sends. */
export interface RequestValidationErrorBody {
  code: "REQUEST_VALIDATION_FAILED";
  message: string;
  errors: RequestValidationIssue[];
}

const VALIDATED = Symbol.for("erp.validatedRequestInput");
/** Property on a validateRequest middleware listing the parts it validates. */
export const VALIDATED_LOCATIONS = Symbol.for("erp.validatedRequestLocations");

type RequestWithValidated = Request & { [VALIDATED]?: Partial<Record<Location, unknown>> };

/**
 * Throws when an object schema anywhere in `schema` accepts unknown keys.
 * Records are allowed: they are maps by design. `seen` guards recursive
 * (lazy) schemas.
 */
export function assertStrictSchema(schema: z.ZodType, where: string, seen = new Set<unknown>()): void {
  if (seen.has(schema)) return;
  seen.add(schema);
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> & { type: string } } })._zod.def;
  const recurse = (child: unknown, suffix: string) => {
    if (child) assertStrictSchema(child as z.ZodType, `${where}${suffix}`, seen);
  };

  switch (def.type) {
    case "object": {
      const catchall = def.catchall as { _zod?: { def?: { type?: string } } } | undefined;
      if (catchall?._zod?.def?.type !== "never") {
        throw new Error(
          `validateRequest: ${where} is a non-strict object schema. Use z.strictObject(...) or .strict() so unknown fields are rejected.`
        );
      }
      for (const [key, child] of Object.entries(def.shape as Record<string, unknown>)) recurse(child, `.${key}`);
      return;
    }
    case "array":
      return recurse(def.element, "[]");
    case "tuple":
      (def.items as unknown[]).forEach((item, index) => recurse(item, `[${index}]`));
      return recurse(def.rest, "[...]");
    case "union":
      (def.options as unknown[]).forEach((option, index) => recurse(option, `|${index}`));
      return;
    case "intersection":
      recurse(def.left, "&left");
      return recurse(def.right, "&right");
    case "record":
    case "map":
      return recurse(def.valueType, "{value}");
    case "set":
      return recurse(def.valueType, "{item}");
    case "pipe":
      return recurse(def.in, "");
    case "lazy":
      return recurse((def.getter as () => unknown)(), "");
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "nonoptional":
    case "readonly":
    case "catch":
    case "success":
      return recurse(def.innerType, "");
    default:
      return;
  }
}

function formatPath(path: PropertyKey[]): string {
  return path.map((segment) => String(segment)).join(".");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Zod returns objects with keys in schema order. Some handlers hash or
 * serialise `req.body` (idempotency fingerprints, audit snapshots), so put the
 * keys back in the order the client sent them. Keys the schema added
 * (defaults) follow the client's keys.
 */
export function alignKeyOrder(parsed: unknown, raw: unknown): unknown {
  if (Array.isArray(parsed) && Array.isArray(raw)) {
    return parsed.map((item, index) => alignKeyOrder(item, raw[index]));
  }
  if (!isPlainObject(parsed) || !isPlainObject(raw)) return parsed;
  const aligned: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (key in parsed) aligned[key] = alignKeyOrder(parsed[key], raw[key]);
  }
  for (const key of Object.keys(parsed)) {
    if (!(key in aligned)) aligned[key] = parsed[key];
  }
  return aligned;
}

/**
 * Express middleware that parses `req.params`, `req.query` and `req.body`
 * against the given schemas. On failure it answers 400 with
 * RequestValidationErrorBody and stops the chain. On success `req.body` is
 * replaced by the parsed body, and all parsed parts are readable through
 * `validatedInput(req, schemas)`.
 */
export function validateRequest<S extends RequestSchemas>(schemas: S): RequestHandler {
  if (!LOCATIONS.some((location) => schemas[location])) {
    throw new Error("validateRequest: declare at least one of body, params or query.");
  }
  for (const location of LOCATIONS) {
    const schema = schemas[location];
    if (schema) assertStrictSchema(schema, location);
  }

  // A named function expression: the route manifest records this name.
  const middleware = function validateRequest(req: Request, res: Response, next: NextFunction) {
    const errors: RequestValidationIssue[] = [];
    const parsed: Partial<Record<Location, unknown>> = {};
    for (const location of LOCATIONS) {
      const schema = schemas[location];
      if (!schema) continue;
      const result = schema.safeParse((req as unknown as Record<Location, unknown>)[location]);
      if (result.success) {
        parsed[location] = result.data;
      } else {
        for (const issue of result.error.issues) {
          errors.push({ location, path: formatPath(issue.path), code: issue.code, message: issue.message });
        }
      }
    }

    if (errors.length > 0) {
      // A fixed, translated message; the per-field detail is in `errors`.
      const body: RequestValidationErrorBody = {
        code: "REQUEST_VALIDATION_FAILED",
        message: "Invalid request data",
        errors,
      };
      res.status(400).json(body);
      return;
    }

    if ("body" in parsed) req.body = alignKeyOrder(parsed.body, req.body);
    (req as RequestWithValidated)[VALIDATED] = parsed;
    next();
  };
  // Which parts this middleware checks. tests/write-route-validation.test.ts
  // reads it from the live route stack to require a params schema on every
  // route with path parameters and a body schema on every POST/PUT/PATCH.
  return Object.assign(middleware, {
    [VALIDATED_LOCATIONS]: LOCATIONS.filter((location) => schemas[location]),
  });
}

/**
 * The parsed input for a request that passed `validateRequest(schemas)`. Pass
 * the same `schemas` object so the result is typed. Throws if the middleware
 * did not run, which is a wiring bug, not a client error.
 */
export function validatedInput<S extends RequestSchemas>(req: Request, _schemas: S): ValidatedInput<S> {
  const parsed = (req as RequestWithValidated)[VALIDATED];
  if (!parsed) throw new Error("validatedInput: validateRequest did not run for this route.");
  return parsed as ValidatedInput<S>;
}

// ---------------------------------------------------------------------------
// Building blocks for route schemas.
// ---------------------------------------------------------------------------

/** A path or query segment holding a positive integer id, parsed to a number. */
export const positiveIntParam = z
  .string()
  .regex(/^[1-9]\d*$/, "Expected a positive integer")
  .transform((value) => Number(value))
  .refine((value) => Number.isSafeInteger(value), "Integer is too large");

/** A non-empty path segment kept as a string (varchar and uuid ids). */
export const stringParam = z.string().min(1);

/** `{ id }` with a positive integer id: the most common write-route params. */
export const idParams = z.strictObject({ id: positiveIntParam });

/** `{ id }` with a string id (users, sessions, uuids). */
export const stringIdParams = z.strictObject({ id: stringParam });

/**
 * For routes that take no body (most DELETEs, action POSTs). Accepts no body
 * at all or an empty JSON object, and rejects anything else.
 */
export const emptyBody = z.union([z.undefined(), z.strictObject({})]);

/** For routes that take no query string. */
export const emptyQuery = z.strictObject({});
