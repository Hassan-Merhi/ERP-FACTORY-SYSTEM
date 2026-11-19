import { Shield, ChevronDown, ChevronRight, User } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { FACTORY_COST_FIELDS, ERP_COST_FIELDS } from "./UserManagementConstants";
import { FACTORY_EMPTY_CONTAINER_GRANT_KEY } from "@shared/factoryPermissionCatalog";
import {
  AdvancedRestrictionsSection,
  AdvancedRestrictionsSection2,
  useAdvancedRestrictionsState,
  type AdvancedRestrictionsProps,
} from "./AdvancedRestrictionsSection";
import { AdvancedRestrictionsContent } from "./AdvancedRestrictionsContent";

export function AdvancedRestrictions(props: AdvancedRestrictionsProps) {
  const {
    advancedOpen,
    emptyContainerGranted,
    hasErpAccess,
    hasFactoryAccess,
    hiddenCostFields,
    hiddenErpCostFields,
    hiddenFieldCount,
    hiddenTabCount,
    isPrivileged,
    isViewOnly,
    openTabGroups,
    pageAccess,
    relevantPageCount,
    restrictionCount,
    setAdvancedOpen,
    setFactoryTabsVisible,
    setHiddenCostFields,
    setPageAccess,
    toggleCostField,
    toggleErpCostField,
    toggleGroup,
    togglePage,
    toggleTabGroup,
    user,
  } = useAdvancedRestrictionsState(props);

  return (
    <Card>
      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger asChild>
          <CardHeader className="pb-3 cursor-pointer select-none" data-testid="button-toggle-advanced-restrictions">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Shield className="h-4 w-4" />
                Advanced Restrictions
                {restrictionCount > 0 && (
                  <Badge variant="secondary" className="text-xs font-normal ml-1">
                    {restrictionCount} active
                  </Badge>
                )}
              </CardTitle>
              <div className="text-muted-foreground">
                {advancedOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </div>
            </div>
            {!advancedOpen &&
              (() => {
                const pageCount = relevantPageCount;
                const tabCount = hiddenTabCount;
                const fieldCount = hiddenFieldCount;
                const erpCount = isPrivileged ? 0 : hiddenErpCostFields.length;
                const parts: string[] = [];
                if (pageCount > 0) parts.push(`${pageCount} page${pageCount !== 1 ? "s" : ""} explicitly allowed`);
                if (tabCount > 0) parts.push(`${tabCount} tab${tabCount !== 1 ? "s" : ""} hidden`);
                if (fieldCount > 0) parts.push(`${fieldCount} Factory field${fieldCount !== 1 ? "s" : ""} hidden`);
                if (erpCount > 0) parts.push(`${erpCount} ERP field${erpCount !== 1 ? "s" : ""} hidden`);
                if (emptyContainerGranted) parts.push("Empty Container allowed");
                return (
                  <p className="text-xs text-muted-foreground font-normal mt-1">
                    {parts.length > 0 ? parts.join(" · ") : "No additional restrictions active"}
                  </p>
                );
              })()}
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="space-y-5 pt-0">
            {isPrivileged ? (
              <p className="text-sm text-muted-foreground">
                Admin / Owner / Developer accounts always have full access to all pages.
              </p>
            ) : (
              <>
                <div className="flex items-start gap-2 rounded-md border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30 px-3 py-2 text-xs text-blue-700 dark:text-blue-300">
                  <User className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>
                    These restrictions apply to <strong>{user.username}</strong> personally — they override any
                    role-level defaults for this user only.
                  </span>
                </div>
                {hasFactoryAccess && !isViewOnly && (
                  <div className="space-y-2 rounded-md border p-3" data-testid="section-container-loading-actions">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Container Loading Actions
                    </p>
                    <label className="flex cursor-pointer items-start gap-3">
                      <Checkbox
                        checked={emptyContainerGranted}
                        onCheckedChange={(checked) =>
                          setHiddenCostFields((prev) =>
                            checked === true
                              ? Array.from(new Set([...prev, FACTORY_EMPTY_CONTAINER_GRANT_KEY]))
                              : prev.filter((key) => key !== FACTORY_EMPTY_CONTAINER_GRANT_KEY)
                          )
                        }
                        data-testid="checkbox-allow-empty-container"
                      />
                      <span className="space-y-1">
                        <span className="block text-sm font-medium">Allow Empty Container</span>
                        <span className="block text-xs text-muted-foreground">
                          Allow this user to return all scanned bales from an open container to stock. Does not grant
                          administrator rights. Off by default.
                        </span>
                      </span>
                    </label>
                  </div>
                )}
                {hasFactoryAccess && (
                  <AdvancedRestrictionsSection2
                    pageAccess={pageAccess}
                    setPageAccess={setPageAccess}
                    toggleGroup={toggleGroup}
                    togglePage={togglePage}
                  />
                )}

                {hasErpAccess && isViewOnly && (
                  <div
                    className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground"
                    data-testid="view-only-all-erp-pages"
                  >
                    View Only can browse all standard ERP business-data pages automatically. Older saved ERP page
                    selections do not limit this role. Dashboard, Settings, Create Voucher, and privileged developer
                    tools remain unavailable; all business write actions are blocked.
                  </div>
                )}

                {hasErpAccess && !isViewOnly && (
                  <AdvancedRestrictionsContent
                    pageAccess={pageAccess}
                    setPageAccess={setPageAccess}
                    toggleGroup={toggleGroup}
                    togglePage={togglePage}
                  />
                )}

                {hasFactoryAccess && (
                  <AdvancedRestrictionsSection
                    hiddenCostFields={hiddenCostFields}
                    openTabGroups={openTabGroups}
                    setFactoryTabsVisible={setFactoryTabsVisible}
                    toggleTabGroup={toggleTabGroup}
                  />
                )}

                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Factory Financial & Cost Fields
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Checked fields and financial columns will be hidden from this user.
                  </p>
                  <div className="space-y-1.5 border rounded-md p-3">
                    {FACTORY_COST_FIELDS.map((field) => (
                      <div key={field.key} className="flex items-center gap-2">
                        <Checkbox
                          checked={hiddenCostFields.includes(field.key)}
                          onCheckedChange={() => toggleCostField(field.key)}
                          data-testid={`checkbox-cost-${field.key}`}
                        />
                        <span className="text-sm">{field.label}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Export &amp; Print Visibility
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Checked items will be hidden from this user's exports, PDFs, prints, invoices, proformas, and
                    reports.
                  </p>
                  <div className="space-y-1.5 border rounded-md p-3">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        checked={hiddenCostFields.includes("hide_export_selling_price")}
                        onCheckedChange={() => toggleCostField("hide_export_selling_price")}
                        data-testid="checkbox-cost-hide_export_selling_price"
                      />
                      <span className="text-sm">Hide Selling Prices in Exports/Prints</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        checked={hiddenCostFields.includes("hide_export_cost_price")}
                        onCheckedChange={() => toggleCostField("hide_export_cost_price")}
                        data-testid="checkbox-cost-hide_export_cost_price"
                      />
                      <span className="text-sm">Hide Cost / Production Prices in Exports/Prints</span>
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Daybook Restrictions
                  </p>
                  <div className="border rounded-md p-3">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        checked={hiddenCostFields.includes("daybook_own_only")}
                        onCheckedChange={() => toggleCostField("daybook_own_only")}
                        data-testid="checkbox-daybook-own-only"
                      />
                      <span className="text-sm">Show only entries they created</span>
                    </div>
                  </div>
                </div>

                <div className="space-y-2 pt-2 border-t">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    ERP Cost &amp; Profit Fields
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Checked items will be hidden from this user in the ERP system (sales detail, exports, prints).
                  </p>
                  <div className="space-y-1.5 border rounded-md p-3">
                    {ERP_COST_FIELDS.map((field) => (
                      <div key={field.key} className="flex items-center gap-2">
                        <Checkbox
                          checked={hiddenErpCostFields.includes(field.key)}
                          onCheckedChange={() => toggleErpCostField(field.key)}
                          data-testid={`checkbox-erp-cost-${field.key}`}
                        />
                        <span className="text-sm">{field.label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
