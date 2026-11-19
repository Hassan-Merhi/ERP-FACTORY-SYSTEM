// Extracted from ./AdvancedRestrictions.tsx
import { Check, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ALL_ERP_PAGES, ERP_PAGE_GROUPS } from "./UserManagementConstants";
import { useAdvancedRestrictionsState } from "./AdvancedRestrictionsSection";

export function AdvancedRestrictionsContent({
  pageAccess,
  setPageAccess,
  toggleGroup,
  togglePage,
}: Pick<
  ReturnType<typeof useAdvancedRestrictionsState>,
  "pageAccess" | "setPageAccess" | "toggleGroup" | "togglePage"
>) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">ERP Pages</p>
        <div className="flex gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPageAccess((prev) => new Set([...prev, ...ALL_ERP_PAGES.map((p) => p.key)]))}
            data-testid="button-erp-pages-all"
          >
            <Check className="h-3 w-3 mr-1" />
            All
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setPageAccess((prev) => {
                const next = new Set(prev);
                ALL_ERP_PAGES.forEach((p) => next.delete(p.key));
                return next;
              })
            }
            data-testid="button-erp-pages-none"
          >
            <X className="h-3 w-3 mr-1" />
            None
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Checked pages are <strong>available</strong> to this user. Leave all ERP page checks clear when no per-page ERP
        allow-list is needed.
      </p>
      <div className="space-y-3 border rounded-md p-3 max-h-48 overflow-y-auto">
        {ERP_PAGE_GROUPS.map((group) => {
          const groupPages = ALL_ERP_PAGES.filter((p) => p.group === group);
          const allSel = groupPages.every((p) => pageAccess.has(p.key));
          const someSel = groupPages.some((p) => pageAccess.has(p.key));
          return (
            <div key={`erp-${group}`} className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Checkbox
                  checked={allSel}
                  onCheckedChange={() => toggleGroup(group, groupPages)}
                  data-testid={`checkbox-erp-group-${group.toLowerCase().replace(/\s+/g, "-")}`}
                />
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group}</span>
                {someSel && !allSel && (
                  <Badge variant="secondary" className="text-xs">
                    partial
                  </Badge>
                )}
              </div>
              <div className="ml-6 grid grid-cols-1 md:grid-cols-2 gap-1">
                {groupPages.map((page) => (
                  <div key={page.key} className="flex items-center gap-2">
                    <Checkbox
                      checked={pageAccess.has(page.key)}
                      onCheckedChange={() => togglePage(page.key)}
                      data-testid={`checkbox-erp-page-${page.key}`}
                    />
                    <span className="text-sm">{page.label}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
