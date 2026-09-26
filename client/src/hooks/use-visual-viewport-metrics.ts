import { useEffect } from "react";

const HEIGHT_VAR = "--erp-visual-viewport-height";
const KEYBOARD_VAR = "--erp-keyboard-inset";

/**
 * Publishes the visible viewport to CSS while the ERP shell is mounted.
 *
 * Phone browsers overlay the on-screen keyboard on the layout viewport, so `100dvh` still counts
 * the part the keyboard covers and a bottom sheet anchored to `bottom: 0` hides its action row
 * behind the keyboard. `--erp-visual-viewport-height` is the height the user can actually see
 * and `--erp-keyboard-inset` is how much of the layout viewport's bottom edge is covered, which
 * `erp-mobile-operations.css` uses to lift and cap phone dialogs. When the keyboard opens, the
 * focused field inside a dialog or sheet is scrolled back into view.
 */
export function useVisualViewportMetrics() {
  useEffect(() => {
    const viewport = window.visualViewport;
    const root = document.documentElement;
    if (!viewport) return;

    let frame = 0;
    let lastInset = 0;
    const update = () => {
      frame = 0;
      const visibleHeight = Math.round(viewport.height);
      const inset = Math.max(0, Math.round(window.innerHeight - (viewport.offsetTop + viewport.height)));
      root.style.setProperty(HEIGHT_VAR, `${visibleHeight}px`);
      root.style.setProperty(KEYBOARD_VAR, `${inset}px`);
      if (inset > lastInset + 40) {
        const active = document.activeElement;
        if (
          active instanceof HTMLElement &&
          active.closest(
            '[data-slot="dialog-content"], [data-slot="alert-dialog-content"], [data-slot="sheet-content"]'
          )
        ) {
          active.scrollIntoView({ block: "center", inline: "nearest" });
        }
      }
      lastInset = inset;
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };

    update();
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      root.style.removeProperty(HEIGHT_VAR);
      root.style.removeProperty(KEYBOARD_VAR);
    };
  }, []);
}
