import { SearchField } from "@/components/ui/search-field";
/**
 * AdvancedRestrictionsPanel
 *
 * A self-contained, role-aware restrictions editor that reads/writes
 * the role_feature_permissions table via /api/settings/role-permissions.
 *
 * Checkbox semantics per role:
 *   Owner / Manager / POS  → checked = restriction active   (stored enabled=false)
 *   Normal User            → checked = access granted       (stored enabled=true)
 *
 * Developer / Admin rows are not editable (always full access).
 */

import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Loader2, ChevronDown, ChevronRight, Shield, Info } from "lucide-react";
import { PERMISSION_TYPE_LABELS, UNCONFIGURED_PERMISSIONS } from "@shared/permissionConfig";
import { TYPE_ORDER, type AdvancedRestrictionsPanelProps } from "./AdvancedRestrictionsPanelHelpers";
import { useAdvancedRestrictionsPanelState } from "./useAdvancedRestrictionsPanelState";

export function AdvancedRestrictionsPanel({ role, companyId, companyName }: AdvancedRestrictionsPanelProps) {
  const {
    search,
    setSearch,
    openSections,
    isNormal,
    isPrivileged,
    isLoading,
    updateMutation,
    toggleKey,
    checkAllInGroup,
    toggleSection,
    hasSearch,
    filteredCatalog,
    byType,
    activeCount,
    getChecked,
    groupAllChecked,
    groupSomeChecked,
  } = useAdvancedRestrictionsPanelState({ role, companyId });

  if (isPrivileged) {
    return (
      <div className="flex items-start gap-2 rounded-md border bg-muted/20 px-3 py-2.5 text-sm text-muted-foreground">
        <Shield className="h-4 w-4 mt-0.5 shrink-0" />
        <span>
          <strong>{role}</strong> accounts always have full access. Advanced restrictions do not apply.
        </span>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-4 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading restrictions…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Header / helper text */}
      <div className="space-y-1">
        {isNormal ? (
          <p className="text-xs text-muted-foreground bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-md px-3 py-2">
            <strong>Normal User</strong> has no access by default. Select what this user is allowed to access. Checked
            items are visible/accessible.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Checked items are hidden or restricted from users with the <strong>{role}</strong> role
            {companyName ? ` at ${companyName}` : ""}.
          </p>
        )}
        {activeCount > 0 && (
          <Badge variant="secondary" className="text-xs">
            {activeCount} {isNormal ? "granted" : "restricted"}
          </Badge>
        )}
      </div>

      {/* Search */}
      <SearchField
        value={search}
        onValueChange={setSearch}
        placeholder="Search permissions…"
        className="text-xs"
        data-testid="input-permission-search"
      />

      {/* Sections by type */}
      {TYPE_ORDER.map((type) => {
        if (!byType[type]) return null;
        const typeLabel = PERMISSION_TYPE_LABELS[type];
        const sectionKey = `type-${type}`;
        const isOpen = openSections.has(sectionKey) || hasSearch;
        const allGroupNames = Object.keys(byType[type]);
        const allEntriesInType = allGroupNames.flatMap((g) => byType[type][g]);
        const someChecked = allEntriesInType.some((e) => getChecked(e.key));

        return (
          <Collapsible key={type} open={isOpen} onOpenChange={() => toggleSection(sectionKey)}>
            <CollapsibleTrigger asChild>
              <div
                className="flex items-center justify-between cursor-pointer select-none rounded-md px-3 py-2 bg-muted/30 hover-elevate"
                data-testid={`section-${type}`}
              >
                <div className="flex items-center gap-2">
                  {isOpen ? (
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                  <span className="text-xs font-semibold">{typeLabel}</span>
                  {someChecked && !isNormal && (
                    <Badge variant="secondary" className="text-xs">
                      restricted
                    </Badge>
                  )}
                  {someChecked && isNormal && (
                    <Badge variant="secondary" className="text-xs">
                      granted
                    </Badge>
                  )}
                </div>
                <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs px-2"
                    onClick={() => checkAllInGroup(allEntriesInType, true)}
                    disabled={updateMutation.isPending}
                    data-testid={`button-check-all-${type}`}
                  >
                    {isNormal ? "Allow all" : "Restrict all"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs px-2"
                    onClick={() => checkAllInGroup(allEntriesInType, false)}
                    disabled={updateMutation.isPending}
                    data-testid={`button-uncheck-all-${type}`}
                  >
                    {isNormal ? "Deny all" : "Allow all"}
                  </Button>
                </div>
              </div>
            </CollapsibleTrigger>

            <CollapsibleContent>
              <div className="space-y-3 mt-1 pl-2">
                {allGroupNames.map((groupName) => {
                  const entries = byType[type][groupName];
                  const allChecked = groupAllChecked(entries);
                  const someGroupChecked = groupSomeChecked(entries);

                  return (
                    <div key={groupName} className="space-y-1.5">
                      {/* Group header */}
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Checkbox
                            checked={allChecked}
                            onCheckedChange={(v) => checkAllInGroup(entries, !!v)}
                            disabled={updateMutation.isPending}
                            data-testid={`checkbox-group-${groupName.toLowerCase().replace(/\s+/g, "-")}`}
                          />
                          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            {groupName}
                          </span>
                          {someGroupChecked && !allChecked && (
                            <Badge variant="secondary" className="text-xs">
                              partial
                            </Badge>
                          )}
                        </div>
                      </div>

                      {/* Items */}
                      <div className="ml-6 grid grid-cols-1 gap-1">
                        {entries.map((entry) => {
                          const checked = getChecked(entry.key);
                          return (
                            <div key={entry.key} className="flex items-start gap-2">
                              <Checkbox
                                checked={checked}
                                onCheckedChange={() => toggleKey(entry.key, checked)}
                                disabled={updateMutation.isPending}
                                data-testid={`checkbox-perm-${entry.key}`}
                                className="mt-0.5 shrink-0"
                              />
                              <div className="flex-1 min-w-0">
                                <span className="text-sm">{entry.label}</span>
                                {entry.description && (
                                  <p className="text-xs text-muted-foreground">{entry.description}</p>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </CollapsibleContent>
          </Collapsible>
        );
      })}

      {/* Unconfigured section */}
      {UNCONFIGURED_PERMISSIONS.length > 0 && !hasSearch && (
        <div className="rounded-md border border-dashed px-3 py-2.5 space-y-1">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Info className="h-3.5 w-3.5" />
            <span className="font-semibold uppercase tracking-wide">Auto-detected / Unconfigured</span>
          </div>
          <p className="text-xs text-muted-foreground ml-5">
            These pages/routes exist in the app but haven't been formally catalogued yet.
          </p>
          <div className="ml-5 space-y-1 mt-2">
            {UNCONFIGURED_PERMISSIONS.map((entry) => {
              const checked = getChecked(entry.key);
              return (
                <div key={entry.key} className="flex items-center gap-2">
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => toggleKey(entry.key, checked)}
                    disabled={updateMutation.isPending}
                    data-testid={`checkbox-perm-${entry.key}`}
                  />
                  <span className="text-sm text-muted-foreground">{entry.label}</span>
                  <Badge variant="outline" className="text-xs">
                    unconfigured
                  </Badge>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {filteredCatalog.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-3">No permissions match your search.</p>
      )}

      {updateMutation.isPending && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Saving…
        </div>
      )}
    </div>
  );
}
