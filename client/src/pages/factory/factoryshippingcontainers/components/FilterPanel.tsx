import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type DocsFilter = "all" | "has" | "missing";

function isDocsFilter(value: string): value is DocsFilter {
  return value === "all" || value === "has" || value === "missing";
}

interface FilterPanelProps {
  filterDocs: DocsFilter;
  setFilterDocs: (value: DocsFilter) => void;
  filterStatus: string;
  setFilterStatus: (value: string) => void;
}

/**
 * Documents/status filter row for the shipping containers page. Extracted from
 * FactoryShippingContainers.tsx so that page stays below the repository line cap.
 */
export function FilterPanel({ filterDocs, setFilterDocs, filterStatus, setFilterStatus }: FilterPanelProps) {
  return (
    <div className="flex flex-wrap gap-3 items-center p-3 rounded-md border bg-muted/30">
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">Documents</p>
        <Select
          value={filterDocs}
          onValueChange={(value) => {
            if (isDocsFilter(value)) setFilterDocs(value);
          }}
        >
          <SelectTrigger className="h-8 text-xs w-36" data-testid="select-filter-docs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="has">Has Documents</SelectItem>
            <SelectItem value="missing">Missing Documents</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">Status</p>
        <Select value={filterStatus} onValueChange={setFilterStatus}>
          <SelectTrigger className="h-8 text-xs w-44" data-testid="select-filter-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="LOADING">Loading</SelectItem>
            <SelectItem value="VERIFIED">Verified</SelectItem>
            <SelectItem value="FINALIZED">Finalized</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-end">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-xs"
          onClick={() => {
            setFilterDocs("all");
            setFilterStatus("all");
          }}
          data-testid="button-clear-filters"
        >
          Clear All
        </Button>
      </div>
    </div>
  );
}
