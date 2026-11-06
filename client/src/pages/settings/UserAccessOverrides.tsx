import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Shield, RotateCcw } from "lucide-react";
import { useCompany } from "@/contexts/CompanyContext";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  matrixActions,
  matrixResources,
  canStageRoleDecision,
  ruleKey,
  readableResource,
  pendingRoleChanges,
  type RoleChange,
  type RoleRuleKey,
} from "./rolePermissionMatrixModel";
import type { AccessControlAction, AccessControlResource, AccessDecision } from "@shared/accessControlV2";

type Member = { userId: string; role: string };
type Directory = { companyId: number; users: Member[]; mode: "shadow"; enforced: false };
type UserRule = { resource: AccessControlResource; action: AccessControlAction; decision: AccessDecision };
type UserResponse = {
  companyId: number;
  userId: string;
  role: string;
  policy: { revision: number; mode: string };
  rules: UserRule[];
  enforced: boolean;
};
type Preview = {
  companyId: number;
  role: string;
  resource: AccessControlResource;
  action: AccessControlAction;
  routeVerified: false;
  currentlyEnforcedByV2: false;
  roleDecision: AccessDecision;
  userDecision: AccessDecision;
  shadowUnverified: { allowed: boolean; reason: string };
  hypotheticalIfHandlerVerified: { allowed: boolean; reason: string };
  legacyModuleOnly: true;
};
const EMPTY: UserRule[] = [];
const MAX_BATCH = 100;
function formatAction(action: string) {
  return action.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}
async function readJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "include", cache: "no-store" });
  if (!response.ok) throw new Error(`Access API returned HTTP ${response.status}`);
  return response.json() as Promise<T>;
}
function rowsToMap(rows: UserRule[]) {
  return new Map<RoleRuleKey, AccessDecision>(rows.map((row) => [ruleKey(row.resource, row.action), row.decision]));
}

/** Company-scoped, shadow-only per-user decisions. Role assignment stays in the existing hardened editor. */
export function UserAccessOverrides() {
  const { selectedCompany } = useCompany();
  const companyId = selectedCompany?.id;
  const client = useQueryClient();
  const [userId, setUserId] = useState("");
  const [module, setModule] = useState("all");
  const [filter, setFilter] = useState("");
  const [draft, setDraft] = useState<Map<RoleRuleKey, AccessDecision>>(new Map());
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState("");
  const [previewResource, setPreviewResource] = useState<AccessControlResource>("erp.vouchers");
  const [previewAction, setPreviewAction] = useState<AccessControlAction>("view");

  const members = useQuery<Directory>({
    queryKey: ["/api/permissions-v2/users", companyId],
    queryFn: () => readJson<Directory>("/api/permissions-v2/users"),
    enabled: !!companyId,
    retry: false,
  });
  const user = useQuery<UserResponse>({
    queryKey: ["/api/permissions-v2/users", companyId, userId, "overrides"],
    queryFn: () => readJson<UserResponse>(`/api/permissions-v2/users/${encodeURIComponent(userId)}/overrides`),
    enabled: !!companyId && !!userId && members.data?.companyId === companyId,
    retry: false,
  });
  const preview = useQuery<Preview>({
    queryKey: [
      "/api/permissions-v2/preview",
      companyId,
      userId,
      previewResource,
      previewAction,
      user.data?.policy?.revision,
    ],
    queryFn: () =>
      readJson<Preview>(
        `/api/permissions-v2/preview?userId=${encodeURIComponent(userId)}&resource=${encodeURIComponent(previewResource)}&action=${encodeURIComponent(previewAction)}`
      ),
    enabled: !!userId && !!companyId && user.data?.companyId === companyId && user.isSuccess,
    retry: false,
  });
  const saved = useMemo(() => rowsToMap(user.data?.rules ?? EMPTY), [user.data?.rules]);
  useEffect(() => {
    setDraft(new Map(saved));
    setReason("");
    setConfirm(false);
  }, [companyId, userId, saved]);
  useEffect(() => {
    setUserId("");
    setMessage("");
  }, [companyId]);
  const currentMember = members.data?.users?.find((item) => item.userId === userId);
  const locked =
    !currentMember ||
    ["Admin", "Developer"].includes(currentMember.role) ||
    userId === "" ||
    members.data?.companyId !== companyId ||
    user.data?.companyId !== companyId ||
    user.data?.role !== currentMember.role ||
    user.data?.policy?.mode !== "shadow" ||
    user.data?.enforced === true;
  const changes = useMemo(() => pendingRoleChanges(saved, draft), [saved, draft]);
  const rows = matrixResources.filter(
    (resource) =>
      (module === "all" || resource.startsWith(`${module}.`)) &&
      `${resource} ${readableResource(resource)}`.toLowerCase().includes(filter.toLowerCase())
  );
  const canSave =
    !locked &&
    changes.length > 0 &&
    changes.length <= MAX_BATCH &&
    reason.trim().length >= 10 &&
    reason.trim().length <= 500;
  const batch = useMutation({
    mutationFn: async (payload: { expectedRevision: number; changes: RoleChange[]; reason: string }) => {
      const response = await apiRequest("PUT", "/api/permissions-v2/user-overrides", { userId, ...payload });
      return response.json() as Promise<{ revision: number; applied: number }>;
    },
    onSuccess: async (result) => {
      setConfirm(false);
      setMessage(
        `Saved ${result.applied} shadow overrides at revision ${result.revision}. No live permissions were changed.`
      );
      await client.invalidateQueries({ queryKey: ["/api/permissions-v2/users", companyId, userId, "overrides"] });
      await client.invalidateQueries({ queryKey: ["/api/permissions-v2/preview"] });
    },
    onError: async (error: Error) => {
      setConfirm(false);
      setMessage(`Save failed: ${error.message}. Refresh the policy and review conflicting changes.`);
      await client.invalidateQueries({ queryKey: ["/api/permissions-v2/users", companyId, userId, "overrides"] });
    },
  });

  const setDecision = (resource: AccessControlResource, action: AccessControlAction, decision: AccessDecision) => {
    if (locked || !canStageRoleDecision(currentMember?.role ?? "", resource, action, decision)) return;
    setDraft((previous) => new Map(previous).set(ruleKey(resource, action), decision));
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Shield className="h-5 w-5" /> User Access — Shadow Overrides
        </CardTitle>
        <CardDescription>
          Choose an existing company member to stage individual exceptions. Role assignment remains in the existing
          Company Roles editor; no new role is activated here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {message && (
          <p role="status" className="rounded-md border p-3 text-sm">
            {message}
          </p>
        )}
        {members.isError && (
          <p role="alert" className="text-sm text-destructive">
            Company members unavailable: {members.error.message}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="space-y-1 text-sm font-medium">
            Company member
            <Select
              value={userId}
              onValueChange={setUserId}
              disabled={!members.data || members.data.companyId !== companyId}
            >
              <SelectTrigger aria-label="Company member">
                <SelectValue placeholder="Choose a user" />
              </SelectTrigger>
              <SelectContent>
                {members.data?.users?.map((member) => (
                  <SelectItem key={member.userId} value={member.userId}>
                    {member.userId} — {member.role}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="space-y-1 text-sm font-medium">
            Module
            <Select value={module} onValueChange={setModule}>
              <SelectTrigger aria-label="Override module">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All modules</SelectItem>
                {["erp", "factory", "retail", "properties", "system"].map((item) => (
                  <SelectItem key={item} value={item}>
                    {formatAction(item)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="space-y-1 text-sm font-medium">
            Search
            <Input
              aria-label="Search override resources"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Find a resource"
            />
          </label>
        </div>
        {user.isError && (
          <p role="alert" className="text-sm text-destructive">
            Policy unavailable: {user.error.message}
          </p>
        )}
        {user.data && user.data.companyId === companyId && (
          <>
            <p className="text-sm">
              Current company role: <strong>{user.data.role}</strong> · policy revision {user.data.policy.revision} ·{" "}
              {changes.length} unsaved exceptions
            </p>
            {locked && (
              <p className="text-sm text-amber-700 dark:text-amber-300">
                This user's role is protected or the company policy is not editable in shadow mode.
              </p>
            )}
            <div
              role="region"
              aria-label="Individual user overrides"
              tabIndex={0}
              className="max-w-full overflow-x-auto rounded-md border"
            >
              <table className="w-full min-w-[920px] text-xs">
                <thead className="bg-muted">
                  <tr>
                    <th scope="col" className="sticky left-0 bg-muted p-2 text-left">
                      Resource
                    </th>
                    {matrixActions.map((action) => (
                      <th key={action} scope="col" className="p-2 text-left">
                        {formatAction(action)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((resource) => (
                    <tr key={resource} className="border-t">
                      <th scope="row" className="sticky left-0 bg-background p-2 text-left">
                        {readableResource(resource)}
                        <span className="block font-normal text-muted-foreground">{resource}</span>
                      </th>
                      {matrixActions.map((action) => {
                        const key = ruleKey(resource, action);
                        const decision = draft.get(key) ?? "inherit";
                        return (
                          <td
                            key={action}
                            className={decision !== (saved.get(key) ?? "inherit") ? "bg-primary/10 p-1" : "p-1"}
                          >
                            <select
                              aria-label={`${resource} ${action} user decision`}
                              value={decision}
                              disabled={locked || batch.isPending}
                              className="w-full min-w-[67px] rounded border bg-background p-1.5"
                              onChange={(event) => setDecision(resource, action, event.target.value as AccessDecision)}
                            >
                              {(["inherit", "allow", "deny"] as const).map((value) => (
                                <option
                                  key={value}
                                  value={value}
                                  disabled={!canStageRoleDecision(currentMember?.role ?? "", resource, action, value)}
                                >
                                  {value}
                                </option>
                              ))}
                            </select>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={locked || batch.isPending}
                onClick={() => {
                  const next = new Map(draft);
                  rows.forEach((resource) =>
                    matrixActions.forEach((action) => next.set(ruleKey(resource, action), "inherit"))
                  );
                  setDraft(next);
                }}
              >
                <RotateCcw className="mr-1 h-4 w-4" /> Reset visible to role
              </Button>
              <Button size="sm" variant="outline" onClick={() => setDraft(new Map(saved))} disabled={batch.isPending}>
                Discard draft
              </Button>
            </div>
            <label className="block space-y-1 text-sm font-medium">
              Reason for change
              <Input
                aria-label="Override change reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={500}
                placeholder="Why should this user's access change?"
              />
            </label>
            {changes.length > MAX_BATCH && (
              <p role="alert" className="text-sm text-destructive">
                Only 100 overrides can be saved per batch.
              </p>
            )}
            <Button disabled={!canSave || batch.isPending} onClick={() => setConfirm(true)}>
              Review {changes.length} overrides
            </Button>
            <div className="rounded-md border p-3 space-y-2 text-sm">
              <h3 className="font-semibold">View as user — diagnostic preview</h3>
              <div className="flex flex-wrap gap-2">
                <Select
                  value={previewResource}
                  onValueChange={(value) => setPreviewResource(value as AccessControlResource)}
                >
                  <SelectTrigger className="w-[210px]" aria-label="Preview resource">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {matrixResources.map((resource) => (
                      <SelectItem key={resource} value={resource}>
                        {resource}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={previewAction} onValueChange={(value) => setPreviewAction(value as AccessControlAction)}>
                  <SelectTrigger className="w-[160px]" aria-label="Preview action">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {matrixActions.map((action) => (
                      <SelectItem key={action} value={action}>
                        {formatAction(action)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {preview.data && preview.data.companyId === companyId ? (
                <p>
                  Role rule: {preview.data.roleDecision} · user exception: {preview.data.userDecision} · proposed result
                  if handler verified:{" "}
                  <strong>{preview.data.hypotheticalIfHandlerVerified.allowed ? "Allow" : "Deny"}</strong> (
                  {preview.data.hypotheticalIfHandlerVerified.reason})
                </p>
              ) : (
                <p className="text-muted-foreground">Preview not available.</p>
              )}
              <p className="text-muted-foreground text-xs">
                Server-side hypothetical only; no impersonation. Does not account for all legacy page, location, field,
                or hard-denial policies and never grants live access.
              </p>
            </div>
          </>
        )}
        <Dialog open={confirm} onOpenChange={setConfirm}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Review user-specific overrides</DialogTitle>
              <DialogDescription>
                Company: {selectedCompany?.name} · User: {userId}. Proposed shadow changes only.
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-56 overflow-y-auto text-sm">
              {changes.map((change) => (
                <p key={ruleKey(change.resource, change.action)}>
                  {change.resource} / {change.action}: {saved.get(ruleKey(change.resource, change.action)) ?? "inherit"}{" "}
                  → <strong>{change.decision}</strong>
                </p>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">Reason: {reason}</p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirm(false)}>
                Cancel
              </Button>
              <Button
                disabled={!canSave || batch.isPending}
                onClick={() =>
                  user.data &&
                  batch.mutate({
                    changes,
                    reason: reason.trim(),
                    expectedRevision: user.data.policy.revision,
                  })
                }
              >
                {batch.isPending ? "Saving…" : "Save shadow overrides"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
