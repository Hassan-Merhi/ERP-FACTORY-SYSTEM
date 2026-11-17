type DakzoBrandProps = { compact?: boolean; className?: string; showName?: boolean };
/** High-contrast, theme-aware transparent branding shared across ERP modules. */
export function DakzoBrand({ compact = false, className = "", showName = true }: DakzoBrandProps) {
  return (
    <span className={`inline-flex min-w-0 items-center gap-2.5 ${className}`} aria-label="Dakzo Systems">
      <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center">
        <img
          src="/dakzo-mark-light-v2.svg"
          alt=""
          aria-hidden="true"
          className="block h-8 w-8 object-contain dark:hidden"
        />
        <img
          src="/dakzo-mark-dark-v2.svg"
          alt=""
          aria-hidden="true"
          className="hidden h-8 w-8 object-contain dark:block"
        />
      </span>
      {showName && (
        <span className={`min-w-0 truncate font-semibold tracking-tight ${compact ? "text-sm" : "text-base"}`}>
          Dakzo Systems
        </span>
      )}
    </span>
  );
}
