import type { ReactNode } from "react";

type PosWorkspaceColumnsProps = {
  children: ReactNode;
  /** Preserve existing layouts while ERP and retail progressively share POS widgets. */
  layout: "erp" | "retail";
};

/**
 * Shared two-column POS workspace shell.
 *
 * - ERP keeps its desktop-only sales-grid / item-sidebar layout (mobile is separate).
 * - Retail uses an ERP-style variant sales grid and image-enabled item sidebar,
 *   with the same responsive two-column placement and its own retail checkout engine.
 *
 * Presentation-only: neither checkout engine, prices nor journals change.
 */
export function PosWorkspaceColumns({ children, layout }: PosWorkspaceColumnsProps) {
  if (layout === "retail") {
    return <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(360px,0.7fr)]">{children}</div>;
  }

  return (
    <div data-pos-desktop-layout="true" className="hidden lg:flex flex-1 min-h-0 overflow-hidden p-4">
      <div data-pos-desktop-columns="true" className="flex flex-row gap-4 h-full min-h-0 w-full">
        {children}
      </div>
    </div>
  );
}
