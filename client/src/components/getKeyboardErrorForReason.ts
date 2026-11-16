// Extracted from ./RemoteKeyboardControllerOverlay.tsx to keep that module under the source-size cap.
import type { RemoteKeyboardKey } from "@/hooks/remote-keyboard-control-policy";

export function getKeyboardErrorForReason(reason: string | null, t: (v: string) => string): string | null {
  if (!reason) return null;
  const map: Record<string, string> = {
    "local-user-active": t("Employee is actively typing — remote typing paused. Try again in a moment."),
    "no-safe-editable-focus": t(
      "No safe field focused — click a safe search, filter or approved field in the watched screen first."
    ),
    "text-not-supported": t("This field doesn't accept typed text — select a text field."),
    "field-length-limit": t("Field is at its length limit — delete some text first."),
    "invalid-text": t("Text contains blocked control characters."),
    "invalid-key": t("That key isn't allowed remotely."),
    "form-submit-blocked": t("Form submission is blocked remotely."),
    "select-key-blocked": t("This select only supports ArrowUp/Down, Home, End."),
    "checkbox-key-blocked": t("Checkbox not approved — only explicitly approved checkboxes can be toggled remotely."),
    "selection-not-supported": t("This field doesn't support text selection."),
    "vertical-key-not-supported": t("Vertical arrow not supported in this field."),
    "number-step-blocked": t("Number stepping blocked — only approved number fields support ArrowUp/Down."),
    "nothing-to-delete": t("Nothing to delete at the current cursor position."),
    "delete-failed": t("Delete failed."),
    "no-adjacent-field": t("No adjacent safe field to Tab to."),
    "stale-command": t("Command expired before execution."),
    "duplicate-command": t("Duplicate command ignored."),
  };
  return map[reason] ?? t("That field is protected and cannot be edited remotely.");
}

export interface KeyboardResultView {
  commandId: string;
  sessionId: string;
  status: "executed" | "blocked" | "ignored";
  reason: string | null;
  completedAt: string;
}

export type KeyboardPayload =
  { type: "insert-text"; text: string } | { type: "key"; key: RemoteKeyboardKey; shiftKey: boolean };

export const ALLOWED_SPECIAL_KEYS = new Map<string, RemoteKeyboardKey>([
  ["Backspace", "Backspace"],
  ["Delete", "Delete"],
  ["Tab", "Tab"],
  ["Escape", "Escape"],
  ["Enter", "Enter"],
  ["ArrowUp", "ArrowUp"],
  ["ArrowDown", "ArrowDown"],
  ["ArrowLeft", "ArrowLeft"],
  ["ArrowRight", "ArrowRight"],
  ["Home", "Home"],
  ["End", "End"],
  [" ", "Space"],
]);

export const TEXT_BATCH_DELAY_MS = 45;

export const MAX_TEXT_BATCH_CODE_POINTS = 32;

export const MAX_TRANSIENT_RETRIES = 3;

export function authorizationIsFresh(expiresAt: string | null | undefined): boolean {
  if (!expiresAt) return false;
  const value = new Date(expiresAt).getTime();
  return Number.isFinite(value) && value > Date.now();
}
