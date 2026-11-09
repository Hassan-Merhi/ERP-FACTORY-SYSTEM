import { DataTableToolbar, type DataTableToolbarProps } from "@/components/DataTableToolbar";

/**
 * Canonical ERP search/filter row. Search stays visible on phones while
 * advanced page-owned filter controls move into the existing filter sheet.
 * Neither page filters nor request state are duplicated here.
 */
export function ErpListFilters({ mobileFilters = true, ...props }: DataTableToolbarProps) {
  return <DataTableToolbar mobileFilters={mobileFilters} {...props} />;
}
