import { useEffect, type Dispatch, type SetStateAction } from "react";
import { addDays, format } from "date-fns";
export function useBalesHistoryDateKeyboard(setDateFilter: Dispatch<SetStateAction<string>>): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (event.key === "-") {
        event.preventDefault();
        setDateFilter((v) => (v ? format(addDays(new Date(`${v}T00:00:00`), -1), "yyyy-MM-dd") : v));
      } else if (event.key === "+" || (event.key === "=" && event.shiftKey)) {
        event.preventDefault();
        setDateFilter((v) => (v ? format(addDays(new Date(`${v}T00:00:00`), 1), "yyyy-MM-dd") : v));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setDateFilter]);
}
