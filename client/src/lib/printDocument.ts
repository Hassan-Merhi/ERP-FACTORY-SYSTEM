import { toast } from "@/hooks/use-toast";
import { POPUP_BLOCKED_TOAST } from "@/lib/popupBlockedToast";

export interface PrintDocumentOptions {
  /** `window.open` features, e.g. "width=900,height=700". */
  features?: string;
  /**
   * `false` when the HTML prints itself (its own `window.onload` print script),
   * so the dialog is not opened twice. Default `true`.
   */
  print?: boolean;
  /** Longest wait for the window's load event before printing anyway. */
  fallbackMs?: number;
  /** Replaces the standard "Pop-up blocked" toast (e.g. a screen's own toast). */
  onBlocked?: () => void;
  /** Closes the window once the print dialog returns (one-off documents). */
  closeAfterPrint?: boolean;
}

const DEFAULT_FALLBACK_MS = 1000;

/**
 * Opens a report or statement in a new window and prints it: writes the HTML,
 * waits for the window to load (images and fonts included), then opens the
 * browser print dialog. When the browser blocks the window it shows the
 * standard "Pop-up blocked" toast and returns null.
 *
 * Label and barcode print layouts keep their own windows; this helper is for
 * report and statement pop-ups.
 */
export function printDocument(html: string, options: PrintDocumentOptions = {}): Window | null {
  const win = window.open("", "_blank", options.features);
  if (!win) {
    if (options.onBlocked) options.onBlocked();
    else toast(POPUP_BLOCKED_TOAST);
    return null;
  }
  win.document.write(html);
  win.document.close();
  if (options.print === false) return win;

  win.focus();
  let printed = false;
  const printOnce = () => {
    if (printed) return;
    printed = true;
    win.print();
    if (options.closeAfterPrint) win.close();
  };
  // document.open() clears the window's listeners, so listen only after writing.
  win.addEventListener("load", printOnce, { once: true });
  if (win.document.readyState === "complete") setTimeout(printOnce, 0);
  setTimeout(printOnce, options.fallbackMs ?? DEFAULT_FALLBACK_MS);
  return win;
}
