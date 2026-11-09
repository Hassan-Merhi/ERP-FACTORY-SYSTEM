import * as React from "react";

import { Table } from "@/components/ui/table";
import { useTablePrefs, type TableDensity } from "@/hooks/use-table-prefs";

/**
 * The standard ERP list frame. It delegates scrolling, sticky headings,
 * responsive behavior and cell semantics to the existing shared Table.
 * Presentation preferences are persisted per page and company; business
 * filters, ordering and pagination remain owned by the page.
 */
export interface ErpListTableProps extends Omit<React.ComponentProps<typeof Table>, "density"> {
  pageKey: string;
  companyId?: string | number | null;
  /** Compact is the ERP default, but each user can save a different density. */
  defaultDensity?: TableDensity;
  /** Adds a density selector above the desktop table without changing its data. */
  showDensityControl?: boolean;
}

export function ErpListTable({
  pageKey,
  companyId,
  defaultDensity = "compact",
  showDensityControl = true,
  scrollLabel = "ERP data table",
  ...tableProps
}: ErpListTableProps) {
  const { prefs, setPrefs } = useTablePrefs(pageKey, { companyId });
  const density = prefs.density ?? defaultDensity;
  const densityId = React.useId();

  return (
    <>
      {showDensityControl ? (
        <div className="mb-2 hidden items-center justify-end gap-2 text-xs text-muted-foreground md:flex phone-land:hidden" data-erp-table-options>
          <label htmlFor={densityId}>Rows</label>
          <select
            id={densityId}
            aria-label="Table row density"
            className="h-8 rounded-md border border-input bg-background px-2 text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            value={density}
            onChange={(event) => setPrefs({ density: event.target.value as TableDensity })}
          >
            <option value="compact">Compact</option>
            <option value="standard">Standard</option>
            <option value="comfortable">Comfortable</option>
          </select>
        </div>
      ) : null}
      <Table
        {...tableProps}
        density={density}
        scrollLabel={scrollLabel}
        data-erp-list-table=""
      />
    </>
  );
}
