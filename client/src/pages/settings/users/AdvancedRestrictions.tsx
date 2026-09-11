import { useState } from "react";
import { Shield, ChevronDown, ChevronRight, User, Check, X } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ALL_FACTORY_PAGES,
  FACTORY_PAGE_GROUPS,
  ALL_ERP_PAGES,
  ERP_PAGE_GROUPS,
  FACTORY_TABS,
  FACTORY_TAB_GROUPS,
  FACTORY_COST_FIELDS,
  ERP_COST_FIELDS,
} from "./UserManagementConstants";
import type { SettingsUserRow } from "../settingsTypes";

interface AdvancedRestrictionsProps {
  user: SettingsUserRow;
  isPrivileged: boolean;
  hasFactoryAccess: boolean;
  hasErpAccess: boolean;
  pageAccess: Set<string>;
  hiddenCostFields: string[];
  hiddenErpCostFields: string[];
  setPageAccess: (v: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  setHiddenCostFields: (v: string[] | ((prev: string[]) => string[])) => void;
  setHiddenErpCostFields: (v: string[] | ((prev: string[]) => string[])) => void;
  openTabGroups: Set<string>;
  toggleTabGroup: (group: string) => void;
}

export function AdvancedRestrictions({
  user,
  isPrivileged,
  hasFactoryAccess,
  hasErpAccess,
  pageAccess,
  hiddenCostFields,
  hiddenErpCostFields,
  setPageAccess,
  setHiddenCostFields,
  setHiddenErpCostFields,
  openTabGroups,
  toggleTabGroup,
}: AdvancedRestrictionsProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const togglePage = (key: string) => {
    setPageAccess((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleGroup = (group: string, pages: { key: string }[]) => {
    const allSelected = pages.every((p) => pageAccess.has(p.key));
    setPageAccess((prev) => {
      const next = new Set(prev);
      pages.forEach((p) => (allSelected ? next.delete(p.key) : next.add(p.key)));
      return next;
    });
  };

  const toggleCostField = (key: string) => {
    setHiddenCostFields((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  const toggleErpCostField = (key: string) => {
    setHiddenErpCostFields((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  const restrictionCount =
    (isPrivileged ? 0 : pageAccess.size) +
    (isPrivileged ? 0 : hiddenCostFields.length) +
    (isPrivileged ? 0 : hiddenErpCostFields.length);

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
                const pageCount = isPrivileged ? 0 : pageAccess.size;
                const costCount = isPrivileged ? 0 : hiddenCostFields.length;
                const erpCount = isPrivileged ? 0 : hiddenErpCostFields.length;
                const parts: string[] = [];
                if (pageCount > 0) parts.push(`${pageCount} page${pageCount !== 1 ? "s" : ""} hidden`);
                if (costCount > 0) parts.push(`${costCount} field${costCount !== 1 ? "s" : ""} hidden`);
                if (erpCount > 0) parts.push(`${erpCount} ERP field${erpCount !== 1 ? "s" : ""} hidden`);
                return (
                  <p className="text-xs text-muted-foreground font-normal mt-1">
                    {parts.length > 0 ? parts.join(" · ") : "No restrictions active — full access"}
                  </p>
                );
              })()}
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="space-y-5 pt-0">
            {isPrivileged ? (
              <p className="text-sm text-muted-foreground">
                Admin / Owner accounts always have full access to all pages.
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
                {hasFactoryAccess && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Factory Pages
                      </p>
                      <div className="flex gap-1.5">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setPageAccess((prev) => new Set([...prev, ...ALL_FACTORY_PAGES.map((p) => p.key)]))
                          }
                          data-testid="button-factory-pages-all"
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
                              ALL_FACTORY_PAGES.forEach((p) => next.delete(p.key));
                              return next;
                            })
                          }
                          data-testid="button-factory-pages-none"
                        >
                          <X className="h-3 w-3 mr-1" />
                          None
                        </Button>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Checked pages will be <strong>hidden</strong> from this user. Leave all unchecked for full factory
                      access.
                    </p>
                    <div className="space-y-3 border rounded-md p-3 max-h-48 overflow-y-auto">
                      {FACTORY_PAGE_GROUPS.map((group) => {
                        const groupPages = ALL_FACTORY_PAGES.filter((p) => p.group === group);
                        const allSel = groupPages.every((p) => pageAccess.has(p.key));
                        const someSel = groupPages.some((p) => pageAccess.has(p.key));
                        return (
                          <div key={group} className="space-y-1.5">
                            <div className="flex items-center gap-2">
                              <Checkbox
                                checked={allSel}
                                onCheckedChange={() => toggleGroup(group, groupPages)}
                                data-testid={`checkbox-group-${group.toLowerCase().replace(/\s+/g, "-")}`}
                              />
                              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                {group}
                              </span>
                              {someSel && !allSel && (
                                <Badge variant="secondary" className="text-xs">
                                  partial
                                </Badge>
                              )}
                            </div>
                            <div className="ml-6 grid grid-cols-2 gap-1">
                              {groupPages.map((page) => (
                                <div key={page.key} className="flex items-center gap-2">
                                  <Checkbox
                                    checked={pageAccess.has(page.key)}
                                    onCheckedChange={() => togglePage(page.key)}
                                    data-testid={`checkbox-page-${page.key.replace(/\//g, "-")}`}
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
                )}

                {hasErpAccess && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">ERP Pages</p>
                      <div className="flex gap-1.5">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setPageAccess((prev) => new Set([...prev, ...ALL_ERP_PAGES.map((p) => p.key)]))
                          }
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
                      Checked pages will be <strong>hidden</strong> from this user. Leave all unchecked for full ERP
                      access.
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
                              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                {group}
                              </span>
                              {someSel && !allSel && (
                                <Badge variant="secondary" className="text-xs">
                                  partial
                                </Badge>
                              )}
                            </div>
                            <div className="ml-6 grid grid-cols-2 gap-1">
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
                )}

                {hasFactoryAccess && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Factory Tabs
                      </p>
                      <div className="flex gap-1.5">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            const allKeys = FACTORY_TABS.map((t) => t.key);
                            setHiddenCostFields((prev) => Array.from(new Set([...prev, ...allKeys])));
                          }}
                          data-testid="button-factory-tabs-hide-all"
                        >
                          <X className="h-3 w-3 mr-1" />
                          Hide All
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            const allKeys = new Set(FACTORY_TABS.map((t) => t.key));
                            setHiddenCostFields((prev) => prev.filter((k) => !allKeys.has(k)));
                          }}
                          data-testid="button-factory-tabs-show-all"
                        >
                          <Check className="h-3 w-3 mr-1" />
                          Show All
                        </Button>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">Checked tabs will be hidden from this user.</p>
                    <div className="space-y-1">
                      {FACTORY_TAB_GROUPS.map((group) => {
                        const groupTabs = FACTORY_TABS.filter((t) => t.group === group);
                        const hiddenCount = groupTabs.filter((t) => hiddenCostFields.includes(t.key)).length;
                        const isOpen = openTabGroups.has(group);
                        return (
                          <Collapsible key={group} open={isOpen} onOpenChange={() => toggleTabGroup(group)}>
                            <CollapsibleTrigger asChild>
                              <div
                                className="flex items-center justify-between cursor-pointer select-none rounded-md px-2.5 py-1.5 bg-muted/30 hover-elevate"
                                data-testid={`group-tabs-${group.toLowerCase().replace(/\s+/g, "-")}`}
                              >
                                <div className="flex items-center gap-2">
                                  {isOpen ? (
                                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                                  ) : (
                                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                                  )}
                                  <span className="text-xs font-semibold">{group}</span>
                                  {hiddenCount > 0 && (
                                    <Badge variant="secondary" className="text-xs">
                                      {hiddenCount} hidden
                                    </Badge>
                                  )}
                                </div>
                                <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 text-xs px-2"
                                    onClick={() =>
                                      setHiddenCostFields((prev) =>
                                        Array.from(new Set([...prev, ...groupTabs.map((t) => t.key)]))
                                      )
                                    }
                                    data-testid={`button-tabs-hide-all-${group}`}
                                  >
                                    Hide all
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 text-xs px-2"
                                    onClick={() => {
                                      const keys = new Set(groupTabs.map((t) => t.key));
                                      setHiddenCostFields((prev) => prev.filter((k) => !keys.has(k)));
                                    }}
                                    data-testid={`button-tabs-show-all-${group}`}
                                  >
                                    Show all
                                  </Button>
                                </div>
                              </div>
                            </CollapsibleTrigger>
                            <CollapsibleContent>
                              <div className="grid grid-cols-2 gap-1 px-2 py-1.5 pl-8">
                                {groupTabs.map((tab) => (
                                  <div key={tab.key} className="flex items-center gap-2">
                                    <Checkbox
                                      checked={hiddenCostFields.includes(tab.key)}
                                      onCheckedChange={() => toggleCostField(tab.key)}
                                      data-testid={`checkbox-tab-${tab.key}`}
                                    />
                                    <span className="text-sm">{tab.label}</span>
                                  </div>
                                ))}
                              </div>
                            </CollapsibleContent>
                          </Collapsible>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Hidden Cost Fields
                  </p>
                  <p className="text-xs text-muted-foreground">Checked fields will be hidden from this user.</p>
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
