import type { HTMLAttributes, ReactNode } from "react";

import { PageHeader, type PageHeaderProps } from "@/components/PageHeader";
import { PageShell, type PageShellLayout } from "@/components/ui/page-shell";

/**
 * The standard ERP page composition.
 *
 * This deliberately delegates to the existing shared primitives instead of
 * introducing a second page layout, header, or theme implementation.
 * Only ERP routes should import this adapter; Factory and Properties keep
 * their independent shells and theme scopes.
 *
 * Existing pages can keep their PageShell layout and PageHeader behavior
 * while adopting a single documented contract for new ERP screens.
 */
export interface ErpPageProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "title" | "children">,
    Omit<PageHeaderProps, "children" | "showHomeButton"> {
  children: ReactNode;
  /** Action buttons / period controls rendered in the canonical header. */
  headerActions?: ReactNode;
  /** Defaults to the existing padded PageShell layout for legacy compatibility. */
  layout?: PageShellLayout;
}

export function ErpPage({
  title,
  subtitle,
  meta,
  icon,
  showBackButton,
  backTarget,
  onBack,
  backButtonTestId,
  showCursorNavButtons,
  headerActions,
  layout = "padded",
  children,
  className,
  ...pageProps
}: ErpPageProps) {
  return (
    <PageShell layout={layout} className={className} data-erp-page="" {...pageProps}>
      <PageHeader
        title={title}
        subtitle={subtitle}
        meta={meta}
        icon={icon}
        showBackButton={showBackButton}
        backTarget={backTarget}
        onBack={onBack}
        backButtonTestId={backButtonTestId}
        showCursorNavButtons={showCursorNavButtons}
      >
        {headerActions}
      </PageHeader>
      {children}
    </PageShell>
  );
}
