import { useEffect } from "react";

/**
 * Marks `<html data-app-shell>` while a shell is mounted. Portalled dialogs render outside the
 * shell, and a shell's global stylesheet stays loaded after the SPA moves to another shell, so
 * shell-only dialog styling keys off this marker instead of the shell's own DOM.
 */
export function useDocumentAppShell(shell: string) {
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.appShell = shell;
    return () => {
      if (root.dataset.appShell === shell) delete root.dataset.appShell;
    };
  }, [shell]);
}
