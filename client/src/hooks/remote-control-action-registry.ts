/**
 * Generated `data-remote-control-action` registry — usable allowlist for remote mouse control.
 *
 * Every value here is actively used by a reviewed read-only or navigation-safe
 * control. The verifier keeps the registry exact: unregistered usages and stale
 * forward-registered values both fail CI so coverage cannot silently drift.
 */
export const REMOTE_CONTROL_ALLOWED_ACTIONS = [
  "navigation",
  "toggle-view",
  "view",
  "view-container",
  "view-details",
  "view-invoice",
  "view-profitability",
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
