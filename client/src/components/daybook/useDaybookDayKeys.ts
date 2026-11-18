import { useEffect } from "react";
import { hasAnyOpenDialog } from "@/hooks/use-escape-back";

/**
 * Daybook day stepping from the keyboard: "-" moves the period one day back,
 * "+" (or "=") one day forward. Ignored while typing or with a dialog open.
 */
export function useDaybookDayKeys(shiftDay: (delta: number) => void) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (hasAnyOpenDialog()) return;
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      const isBack = e.key === "-" || e.code === "Minus";
      const isForward = (e.key === "+" && e.shiftKey) || (e.code === "Equal" && e.shiftKey) || e.key === "=";
      if (isBack) {
        e.preventDefault();
        shiftDay(-1);
      } else if (isForward) {
        e.preventDefault();
        shiftDay(1);
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [shiftDay]);
}
