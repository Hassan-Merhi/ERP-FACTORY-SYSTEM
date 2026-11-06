/**
 * Phase 3: one document-level switch for decorative, CSS-only Christmas accents.
 * It is global across ERP, Factory, Properties, Supplier Partner and POS shells.
 * Decorations never own business interaction state and disappear on logout.
 */
import { useEffect } from "react";
import "@/styles/christmas-decorations.css";

export function GlobalSeasonalDecorations({ enabled }: { enabled: boolean }) {

  useEffect(() => {
    const root = document.documentElement;
    if (enabled) root.dataset.christmasMode = "on";
    else delete root.dataset.christmasMode;

    // Avoid leaking decorations into the login screen or another user session.
    return () => {
      delete root.dataset.christmasMode;
    };
  }, [enabled]);

  return null;
}
