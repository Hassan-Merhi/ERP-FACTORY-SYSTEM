/**
 * Generated `data-remote-control-action` registry — usable allowlist for remote mouse control.
 *
 * Every value here was explicitly reviewed as a read-only or navigation-safe action.
 * The mouse policy only allows clicks when the target carries one of these values,
 * in addition to the existing text-heuristic fallbacks. Adding a new allowlisted
 * control requires adding its action to this registry first; the verifier
 * `scripts/verify-remote-control-action-registry.mjs` fails CI when a
 * `data-remote-control-action` value is used without being registered or when a
 * registry entry has no matching usage.
 *
 * This file is the source of truth — see `scripts/generate-remote-control-action-registry.mjs`
 * for the scanner that keeps the registry and the codebase in sync.
 */
export const REMOTE_CONTROL_ALLOWED_ACTIONS = [
  "view",
  "view-details",
  "view-invoice",
  "view-container",
  "view-deleted-item",
  "view-profitability",
  "view-history",
  "open",
  "close",
  "back",
  "next",
  "previous",
  "expand",
  "collapse",
  "show",
  "hide",
  "search",
  "filter",
  "refresh",
  "clear-filter",
  "toggle-view",
  "navigation",
  "tab",
  "history",
] as const;

export type RemoteControlAction = (typeof REMOTE_CONTROL_ALLOWED_ACTIONS)[number];

export const REMOTE_CONTROL_ACTION_SET = new Set<string>(REMOTE_CONTROL_ALLOWED_ACTIONS);

export function isRegisteredRemoteControlAction(action: string | null | undefined): boolean {
  return typeof action === "string" && REMOTE_CONTROL_ACTION_SET.has(action);
}

export function getRemoteControlAction(element: Element | null): string | null {
  if (!element) return null;
  const raw = element.getAttribute("data-remote-control-action");
  if (raw == null) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function describeRemoteControlActionRegistry(): string {
  return REMOTE_CONTROL_ALLOWED_ACTIONS.join(", ");
}
