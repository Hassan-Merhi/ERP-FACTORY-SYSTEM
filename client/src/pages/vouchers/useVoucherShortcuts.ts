import { useEffect, useRef } from "react";
import { hasAnyOpenDialog, useEscapeBack } from "@/hooks/use-escape-back";

/**
 * The one keyboard shortcut set of every voucher form (the set the Payment / Receipt form and the
 * voucher pages already used):
 *
 * - Ctrl+Enter (⌘+Enter on a Mac) saves the voucher, from any field.
 * - Esc cancels an edit and returns to where the voucher was opened from (Daybook, a statement).
 *
 * Wired once here and used through `VoucherActionBar`, so every form gets the same keys.
 */
type SaveShortcut = () => void;

const saveShortcuts: SaveShortcut[] = [];
let listenerAttached = false;

export function isSaveShortcut(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">) {
  return event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
}

function handleKeyDown(event: KeyboardEvent) {
  if (!isSaveShortcut(event) || event.isComposing) return;
  // An open dialog, menu or picker owns the keyboard; its own Enter handling wins.
  if (hasAnyOpenDialog()) return;
  // Only the most recently mounted voucher form answers, so one key press never saves twice.
  const active = saveShortcuts[saveShortcuts.length - 1];
  if (!active) return;
  // Captured before the row handlers, so Ctrl+Enter in an amount or quantity cell saves instead of
  // also moving to the next row.
  event.preventDefault();
  event.stopPropagation();
  active();
}

function attach() {
  if (listenerAttached || typeof document === "undefined") return;
  document.addEventListener("keydown", handleKeyDown, { capture: true });
  listenerAttached = true;
}

function detachWhenUnused() {
  if (!listenerAttached || saveShortcuts.length > 0 || typeof document === "undefined") return;
  document.removeEventListener("keydown", handleKeyDown, { capture: true });
  listenerAttached = false;
}

export interface VoucherShortcutHandlers {
  /** Runs on Ctrl/⌘+Enter. It should do exactly what clicking Save does (including staying put when disabled). */
  onSave: () => void;
  /** Runs on Esc. Omitted for a new voucher, which has nothing to cancel to. */
  onCancel?: () => void;
}

export function useVoucherShortcuts({ onSave, onCancel }: VoucherShortcutHandlers) {
  const saveRef = useRef(onSave);
  saveRef.current = onSave;

  useEffect(() => {
    const shortcut: SaveShortcut = () => saveRef.current();
    saveShortcuts.push(shortcut);
    attach();
    return () => {
      const index = saveShortcuts.lastIndexOf(shortcut);
      if (index >= 0) saveShortcuts.splice(index, 1);
      detachWhenUnused();
    };
  }, []);

  useEscapeBack(onCancel ?? null);
}

/** Key names shown on the buttons. */
export function voucherShortcutLabels(): { save: string; cancel: string } {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || "");
  return { save: isMac ? "⌘ Enter" : "Ctrl+Enter", cancel: "Esc" };
}
