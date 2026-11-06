/**
 * A one-time post-authentication hint used by the Christmas welcome animation.
 *
 * This is deliberately tab-scoped, contains no user information, and is only
 * written by the successful login flow. It is never an authentication token.
 * Consuming it deletes the hint so refreshes, route switches, and company
 * switches cannot replay the entrance.
 */
export const CHRISTMAS_LOGIN_ENTRANCE_KEY = "christmas:login-entrance:v1";
const MAX_PENDING_AGE_MS = 120_000;

export function markChristmasLoginEntrancePending(now = Date.now()): void {
  try {
    window.sessionStorage.setItem(CHRISTMAS_LOGIN_ENTRANCE_KEY, String(now));
  } catch {
    // Storage can be disabled; it must never prevent a successful login.
  }
}

export function consumeChristmasLoginEntrancePending(now = Date.now()): boolean {
  try {
    const stored = window.sessionStorage.getItem(CHRISTMAS_LOGIN_ENTRANCE_KEY);
    window.sessionStorage.removeItem(CHRISTMAS_LOGIN_ENTRANCE_KEY);
    if (stored === null || stored.trim() === "") return false;
    const timestamp = Number(stored);
    return Number.isFinite(timestamp) && timestamp > 0 && now >= timestamp && now - timestamp <= MAX_PENDING_AGE_MS;
  } catch {
    // If storage is inaccessible there is no safe way to claim a fresh login.
    return false;
  }
}

export function clearChristmasLoginEntrancePending(): void {
  try {
    window.sessionStorage.removeItem(CHRISTMAS_LOGIN_ENTRANCE_KEY);
  } catch {
    // Logout must never fail because the browser denies session storage.
  }
}
