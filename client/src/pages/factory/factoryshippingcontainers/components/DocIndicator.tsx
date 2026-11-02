/**
 * DocIndicator — extracted sub-component.
 *
 * Extracted from FactoryShippingContainers.tsx during the Phase 4 god-file split.
 */
import {CheckCircle2, XCircle} from "lucide-react";

export function DocIndicator({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button onClick={onClick} className="group flex items-center gap-1.5 rounded-md px-1.5 py-1 -mx-1.5 hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-blue-500/10" data-testid="button-open-docs">
      {count > 0 ? (
        <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
      ) : (
        <XCircle className="h-4 w-4 text-red-500 shrink-0" />
      )}
      <span className="text-xs text-muted-foreground group-hover:text-foreground transition-colors underline underline-offset-2">
        {count > 0 ? `${count} file${count !== 1 ? "s" : ""}` : "None"}
      </span>
    </button>
  );
}

// ─── Inline editable text cell ─────────────────────────────────────────────────
