import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, RotateCcw, Search, ShieldCheck } from "lucide-react";
import { useCompany } from "@/contexts/CompanyContext";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  canStageRoleDecision,
  matrixActions,
  matrixResources,
  pendingRoleChanges,
  readableResource,
  roleRulesFor,
  ruleKey,
  type RoleChange,
  type RoleRule,
  type RoleRuleKey,
} from "./rolePermissionMatrixModel";
import type { AccessControlAction, AccessControlResource, AccessDecision } from "@shared/accessControlV2";

type Catalog = { companyId: number; editableRoles: string[]; mode: string; enforced: boolean };
type RoleResponse = {
  companyId: number;
  revision: number;
  mode: string;
  enforced: boolean;
  rules: RoleRule[];
  impactCounts: Record<string, number>;
};
type SaveResponse = { revision: number; applied: number; mode: string };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Permission request failed.";
}
function describeAction(action: string): string {
  return action.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
const groups = ["erp", "factory", "retail", "properties", "system"] as const;
const MAX_BATCH = 100;
const EMPTY_RULES: RoleRule[] = [];

/** Phase 4 is a staging editor, not an active authorization screen. */
export function RolePermissionMatrix() {
  const { selectedCompany } = useCompany();
  const companyId = selectedCompany?.id;
  const queryClient = useQueryClient();
  const [role, setRole] = useState("Manager");
  const [group, setGroup] = useState("all");
  const [search, setSearch] = useState("");
  const [bulkAction, setBulkAction] = useState<AccessControlAction | "all">("all");
  const [draft, setDraft] = useState<Map<RoleRuleKey, AccessDecision>>(new Map());
  const [reason, setReason] = useState("");
  const [showReview, setShowReview] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const catalog = useQuery<Catalog>({
    queryKey: ["/api/permissions-v2/catalog", companyId],
    queryFn: async () => {
      const response = await fetch("/api/permissions-v2/catalog", { credentials: "include", cache: "no-store" });
      if (!response.ok) throw new Error(`Permission catalog unavailable (HTTP ${response.status})`);
      return response.json() as Promise<Catalog>;
    },
    enabled: !!companyId,
    retry: false,
  });
  const roles = useQuery<RoleResponse>({
    queryKey: ["/api/permissions-v2/roles", companyId],
    queryFn: async () => {
      const response = await fetch("/api/permissions-v2/roles", { credentials: "include", cache: "no-store" });
      if (!response.ok) throw new Error(`Shadow policy storage unavailable (HTTP ${response.status})`);
      return response.json() as Promise<RoleResponse>;
    },
    enabled: !!companyId && catalog.isSuccess,
    retry: false,
  });
  const saved = useMemo(() => roleRulesFor(roles.data?.rules ?? EMPTY_RULES, role), [roles.data?.rules, role]);
  // A different company, role, or server revision always resets unsaved state.
  useEffect(() => {
    setDraft(new Map(saved));
    setShowReview(false);
    setReason("");
  }, [companyId, role, saved]);

  const changes = useMemo(() => pendingRoleChanges(saved, draft), [saved, draft]);
  const visibleResources = useMemo(
    () =>
      matrixResources.filter(
        (resource) =>
          (group === "all" || resource.startsWith(`${group}.`)) &&
          (`${resource} ${readableResource(resource)}`.toLowerCase().includes(search.toLowerCase()) ||
            matrixActions.some((action) => action.includes(search.toLowerCase())))
      ),
    [group, search]
  );
  const companyMatches = !!companyId && catalog.data?.companyId === companyId && roles.data?.companyId === companyId;
  const canSave =
    companyMatches &&
    changes.length > 0 &&
    changes.length <= MAX_BATCH &&
    reason.trim().length >= 10 &&
    reason.trim().length <= 500 &&
    roles.data?.mode === "shadow" &&
    !roles.data.enforced;

  const mutation = useMutation<
    SaveResponse,
    Error,
    { changes: RoleChange[]; expectedRevision: number; reason: string }
  >({
    mutationFn: async (body) => {
      const response = await apiRequest("PUT", "/api/permissions-v2/role-rules", { roleKey: role, ...body });
      return response.json() as Promise<SaveResponse>;
    },
    onSuccess: async (result) => {
      setShowReview(false);
      setNotice(
        `Saved ${result.applied} shadow rules at revision ${result.revision}. Live user access was not changed.`
      );
      await queryClient.invalidateQueries({ queryKey: ["/api/permissions-v2/roles", companyId] });
    },
    onError: async (error) => {
      setShowReview(false);
      setNotice(`Save failed: ${errorText(error)}. Refresh the page to recheck current revision before trying again.`);
      await queryClient.invalidateQueries({ queryKey: ["/api/permissions-v2/roles", companyId] });
    },
  });

  const setCell = (resource: AccessControlResource, action: AccessControlAction, decision: AccessDecision) => {
    if (!canStageRoleDecision(role, resource, action, decision)) return;
    setDraft((prior) => new Map(prior).set(ruleKey(resource, action), decision));
  };
  const bulkSet = (decision: AccessDecision, action?: AccessControlAction) => {
    setDraft((prior) => {
      const next = new Map(prior);
      for (const resource of visibleResources) {
        for (const currentAction of matrixActions) {
          if (action && currentAction !== action) continue;
          if (canStageRoleDecision(role, resource, currentAction, decision)) {
            next.set(ruleKey(resource, currentAction), decision);
          }
        }
      }
      return next;
    });
  };

  return (
    <Card className="border-border shadow-sm">
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" aria-hidden="true" />
          <CardTitle className="text-lg">Role Templates — Permission Control Center</CardTitle>
          <span className="rounded-full border px-2 py-0.5 text-xs font-semibold text-amber-700 dark:text-amber-300">
            Shadow mode
          </span>
        </div>
        <CardDescription>
          Stage role permissions for this company. These rules do not grant or revoke live ERP or Factory access.
          Current company: {selectedCompany?.name ?? "None selected"}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!companyId && (
          <p role="alert" className="text-sm text-destructive">
            Select a company before editing permissions.
          </p>
        )}
        {catalog.isError && (
          <p role="alert" className="text-sm text-destructive">
            {errorText(catalog.error)}
          </p>
        )}
        {roles.isError && (
          <p role="alert" className="text-sm text-destructive">
            {errorText(roles.error)}. The separate database migration must be reviewed and applied before this editor
            can load.
          </p>
        )}
        {roles.data && catalog.data && !companyMatches && (
          <p role="alert" className="text-sm text-destructive">
            Active company mismatch. Switch companies again before editing permissions.
          </p>
        )}
        {notice && (
          <p role="status" className="rounded-md border p-3 text-sm">
            {notice}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="space-y-1 text-sm font-medium">
            Role template
            <Select value={role} onValueChange={setRole} disabled={!catalog.data}>
              <SelectTrigger aria-label="Role template">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(catalog.data?.editableRoles ?? []).map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="space-y-1 text-sm font-medium">
            Module
            <Select value={group} onValueChange={setGroup}>
              <SelectTrigger aria-label="Module">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All modules</SelectItem>
                {groups.map((value) => (
                  <SelectItem key={value} value={value}>
                    {describeAction(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="space-y-1 text-sm font-medium">
            Search resources
            <span className="flex items-center gap-2 rounded-md border px-2">
              <Search className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search module, page, action"
                className="border-0 shadow-none"
              />
            </span>
          </label>
        </div>
        {roles.data && companyMatches && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/30 p-3 text-sm">
              <span>
                Company policy revision <strong>{roles.data.revision}</strong> · {roles.data.impactCounts?.[role] ?? 0}{" "}
                assigned users · {changes.length} unsaved changes · maximum {MAX_BATCH} per save
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={bulkAction}
                  onValueChange={(value) => setBulkAction(value as AccessControlAction | "all")}
                >
                  <SelectTrigger className="w-[180px]" aria-label="Bulk action column">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All actions</SelectItem>
                    {matrixActions.map((action) => (
                      <SelectItem key={action} value={action}>
                        {describeAction(action)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => bulkSet("deny", bulkAction === "all" ? undefined : bulkAction)}
                  disabled={mutation.isPending}
                >
                  Deny visible
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => bulkSet("inherit", bulkAction === "all" ? undefined : bulkAction)}
                  disabled={mutation.isPending}
                >
                  Inherit visible
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => bulkSet("allow", bulkAction === "all" ? undefined : bulkAction)}
                  disabled={mutation.isPending}
                >
                  Allow safe visible
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setDraft(new Map(saved))}
                  disabled={mutation.isPending}
                >
                  <RotateCcw className="mr-1 h-4 w-4" /> Reset
                </Button>
              </div>
            </div>
            <div
              className="max-w-full overflow-auto rounded-lg border"
              role="region"
              aria-label="Role permissions matrix"
              tabIndex={0}
            >
              <table className="w-full min-w-[900px] border-collapse text-xs">
                <thead className="sticky top-0 z-10 bg-muted">
                  <tr>
                    <th scope="col" className="sticky left-0 z-20 bg-muted p-3 text-left">
                      Resource
                    </th>
                    {matrixActions.map((action) => (
                      <th scope="col" key={action} className="p-2 text-left">
                        {describeAction(action)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleResources.map((resource) => (
                    <tr key={resource} className="border-t hover:bg-muted/30">
                      <th scope="row" className="sticky left-0 bg-background p-3 text-left font-medium">
                        {readableResource(resource)}
                        <div className="text-[10px] font-normal text-muted-foreground">{resource}</div>
                      </th>
                      {matrixActions.map((action) => {
                        const key = ruleKey(resource, action);
                        const decision = draft.get(key) ?? "inherit";
                        const changed = decision !== (saved.get(key) ?? "inherit");
                        return (
                          <td key={action} className={changed ? "bg-primary/10 p-1" : "p-1"}>
                            <select
                              aria-label={`${resource} ${action} decision`}
                              className="w-full min-w-[69px] rounded-md border bg-background px-1 py-2 text-foreground"
                              value={decision}
                              disabled={mutation.isPending}
                              onChange={(event) => setCell(resource, action, event.target.value as AccessDecision)}
                            >
                              {(["inherit", "allow", "deny"] as const).map((value) => (
                                <option
                                  key={value}
                                  value={value}
                                  disabled={!canStageRoleDecision(role, resource, action, value)}
                                >
                                  {value === "inherit" ? "Inherit" : value === "allow" ? "Allow" : "Deny"}
                                </option>
                              ))}
                            </select>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  {visibleResources.length === 0 && (
                    <tr>
                      <td colSpan={matrixActions.length + 1} className="p-6 text-center">
                        No matching resources
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="space-y-2">
              <label htmlFor="role-change-reason" className="text-sm font-medium">
                Reason for permission change (required)
              </label>
              <Input
                id="role-change-reason"
                value={reason}
                maxLength={500}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Explain the proposed permission changes"
              />
              <p className="text-xs text-muted-foreground">
                Preview before saving. Changes are versioned and audited in shadow storage only.
              </p>
              {changes.length > MAX_BATCH && (
                <p role="alert" className="text-sm text-destructive">
                  Too many changes: save at most 100 per batch.
                </p>
              )}
              <Button disabled={!canSave || mutation.isPending} onClick={() => setShowReview(true)}>
                Review {changes.length} changes
              </Button>
            </div>
          </>
        )}
        <Dialog open={showReview} onOpenChange={setShowReview}>
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle>Review shadow permission changes</DialogTitle>
              <DialogDescription>
                Company: {selectedCompany?.name} · Role: {role} · Revision: {roles.data?.revision}. Nothing here
                activates live permissions.
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-56 overflow-auto rounded-md border p-3 text-sm">
              {changes.map((change) => (
                <div key={ruleKey(change.resource, change.action)} className="border-b py-1 last:border-0">
                  {change.resource} / {describeAction(change.action)}:{" "}
                  <strong>
                    {saved.get(ruleKey(change.resource, change.action)) ?? "inherit"} → {change.decision}
                  </strong>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {roles.data?.impactCounts?.[role] ?? 0} company users are currently assigned this role. This is a role
              impact estimate, not a calculation of effective access or production authorization.
            </p>
            <p className="text-xs text-muted-foreground">Reason: {reason}</p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowReview(false)} disabled={mutation.isPending}>
                Cancel
              </Button>
              <Button
                disabled={!canSave || mutation.isPending}
                onClick={() => {
                  if (!roles.data) return;
                  mutation.mutate({ changes, reason: reason.trim(), expectedRevision: roles.data.revision });
                }}
              >
                {mutation.isPending ? (
                  "Saving..."
                ) : (
                  <>
                    <Check className="mr-1 h-4 w-4" /> Save shadow rules
                  </>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          Existing permissions remain authoritative. Admin and Developer templates are system locked. Inherited means no
          V2 override, not unconditional access.
        </p>
      </CardContent>
    </Card>
  );
}
