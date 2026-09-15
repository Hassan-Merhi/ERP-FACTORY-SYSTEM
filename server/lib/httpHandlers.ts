import type { NextFunction, Request, RequestHandler, Response } from "express";

// Intersect with the globally-augmented `Request["user"]` shape (see the
// Express namespace augmentation in server/index.ts) so this stays a valid
// subtype of Request. User IDs are varchar in the schema, hence `string`.
export interface AuthenticatedRequest extends Request {
  user?: NonNullable<Request["user"]> & {
    id?: string;
    role?: string;
  };
}

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function getAuthenticatedUserId(request: AuthenticatedRequest): string {
  const userId = request.user?.id;
  if (!userId) {
    throw new HttpError(401, "Not authenticated");
  }
  return userId;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected server error";
}

// Legacy route registrars still call this helper as a global. Keep one shared
// implementation while those registrars are migrated to explicit imports.
(globalThis as typeof globalThis & { getErrorMessage?: typeof getErrorMessage }).getErrorMessage = getErrorMessage;

export function getErrorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}

type DatabaseErrorLike = {
  code?: unknown;
  constraint?: unknown;
  detail?: unknown;
  cause?: unknown;
};

function databaseErrorLike(error: unknown): DatabaseErrorLike | null {
  if (!error || typeof error !== "object") return null;
  const outer = error as DatabaseErrorLike;
  const cause = outer.cause;
  if (cause && typeof cause === "object") {
    const inner = cause as DatabaseErrorLike;
    if (typeof inner.code === "string") return inner;
  }
  return outer;
}

/**
 * Translate database/domain conflicts into stable client-facing HTTP failures.
 * This intentionally avoids forwarding PostgreSQL details/constraint names.
 */
export function translateDatabaseError(error: unknown): HttpError | null {
  const candidate = databaseErrorLike(error);
  const code = typeof candidate?.code === "string" ? candidate.code : null;
  if (!code) return null;

  switch (code) {
    case "23502": // not_null_violation
    case "23514": // check_violation
    case "22P02": // invalid_text_representation
    case "22003": // numeric_value_out_of_range
      return new HttpError(400, "The request contains invalid database values.");
    case "23503": // foreign_key_violation
      return new HttpError(409, "The request conflicts with an existing or missing related record.");
    case "23505": // unique_violation
      return new HttpError(409, "A record with the same unique value already exists.");
    case "40001": // serialization_failure
    case "40P01": // deadlock_detected
    case "55P03": // lock_not_available
      return new HttpError(409, "The record changed concurrently. Reload and try again.");
    case "NO_DATA_FOUND":
    case "P0002":
      return new HttpError(404, "The requested record was not found.");
    case "LOCKED_PERIOD":
    case "ACCOUNTING_PERIOD_LOCKED":
      return new HttpError(409, "The accounting period is locked.");
    case "STALE_RECORD":
    case "STALE_WRITE":
      return new HttpError(409, "The record is stale. Reload and try again.");
    default:
      return null;
  }
}

export function sendHttpError(response: Response, error: unknown): void {
  if (error instanceof HttpError) {
    response.status(error.statusCode).json({ message: error.message });
    return;
  }

  const translated = translateDatabaseError(error);
  if (translated) {
    response.status(translated.statusCode).json({ message: translated.message });
    return;
  }

  response.status(500).json({ message: getErrorMessage(error) });
}

export function asyncRoute(
  handler: (request: Request, response: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}
