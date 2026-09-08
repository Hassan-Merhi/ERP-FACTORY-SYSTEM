import type { Request } from "express";

/**
 * The authenticated user id for a request that has already passed `requireAuth`.
 *
 * `SessionData.userId` is declared optional because a pre-login session has no
 * user, so every audit write and repair-token payload that needs a `string` was
 * handed `string | undefined`. That mismatch was invisible while the handlers
 * typed `req` as `any`.
 *
 * `requireAuth` rejects a session without a user before any handler body runs,
 * so this cannot throw on a mounted route. Asserting it here — rather than
 * silencing the compiler with `!` — keeps the impossible case loud instead of
 * writing an audit row or signing a token with an undefined actor.
 */
export function requireSessionUserId(req: Request): string {
  const userId = req.session.userId;
  if (!userId) {
    throw new Error("Authenticated session is missing a user id");
  }
  return userId;
}
