import { useState, useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useCompany } from "@/contexts/CompanyContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Building2, Plus } from "lucide-react";
import { RoleSummaryRow } from "./RoleSummaryRow";
import { InlineRoleEditor } from "./InlineRoleEditor";
import { PosInventoryCostAccessToggle } from "./PosInventoryCostAccessToggle";

interface UserRolesCardProps {
  userId: string;
  companies: any[];
}

export function UserRolesCard({ userId, companies }: UserRolesCardProps) {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const [activeEditorRoleId, setActiveEditorRoleId] = useState<number | "new" | null>(null);
  const [roleToDelete, setRoleToDelete] = useState<any>(null);

  const { data: companyRoles = [] } = useQuery<any[]>({
    queryKey: [`/api/users/${userId}/company-roles`],
    enabled: !!userId,
  });

  // Collect unique companyIds that have POS roles (no hooks in loops)
  const posCompanyIds = useMemo(() => {
    const ids = new Set<number>();
    companyRoles.forEach((r) => {
      if (r.role === "POS" && r.companyId) ids.add(r.companyId);
    });
    return Array.from(ids);
  }, [companyRoles]);

  // Single bulk query for all POS-company locations
  const { data: locationNameMap = {} } = useQuery<Record<number, string>>({
    queryKey: ["/api/locations/bulk-for-roles", posCompanyIds],
    queryFn: async () => {
      const results = await Promise.all(
        posCompanyIds.map(async (cid) => {
          const res = await fetch(`/api/locations?companyId=${cid}`, { credentials: "include" });
          if (!res.ok) return ([]);
          return res.json() as Promise<any[]>;
        })
      );
      const map: Record<number, string> = {};
      results.flat().forEach((loc) => {
        map[loc.id] = loc.name;
      });
      return map;
    },
    enabled: posCompanyIds.length > 0,
  });

  // POS roles that need user-location lookup
  const posRoleKeys = useMemo(
    () => companyRoles.filter((r) => r.role === "POS").map((r) => `${r.id}:${r.companyId}`),
    [companyRoles]
  );

  // Single bulk query for all user-location assignments for POS roles
  const { data: userLocationsMap = {} } = useQuery<Record<number, number[]>>({
    queryKey: ["/api/user-locations/bulk", userId, posRoleKeys],
    queryFn: async () => {
      const posRoles = companyRoles.filter((r) => r.role === "POS");
      const result: Record<number, number[]> = {};
      await Promise.all(
        posRoles.map(async (r) => {
          const res = await fetch(`/api/user-locations/${userId}/${r.companyId}`, { credentials: "include" });
          if (res.ok) {
            const locs = await res.json();
            result[r.id] = Array.isArray(locs) ? locs.map((l) => l.locationId) : [];
          } else {
            result[r.id] = [];
          }
        })
      );
      return result;
    },
    enabled: posRoleKeys.length > 0,
  });

  const deleteRoleMutation = useMutation({
    mutationFn: async (roleId: number) => {
      await apiRequest("DELETE", `/api/user-company-roles/${roleId}`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/users/${userId}/company-roles`] });
      toast({ title: "Role removed" });
      setRoleToDelete(null);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const activeEditingRole =
    activeEditorRoleId === "new" || activeEditorRoleId === null
      ? null
      : (companyRoles.find((r) => r.id === activeEditorRoleId) ?? null);

  const showEditor = activeEditorRoleId !== null;

  const getLocationNames = (role: any): string[] => {
    if (role.role !== "POS") return [];
    const assignedIds = userLocationsMap[role.id] ?? [];
    if (assignedIds.length > 0) {
      return assignedIds.map((id: number) => locationNameMap[id] ?? `#${id}`);
    }
    if (role.assignedLocationId) {
      return [locationNameMap[role.assignedLocationId] ?? `#${role.assignedLocationId}`];
    }
    return [];
  };

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Building2 className="h-4 w-4" />
              Company Roles
            </CardTitle>
            {!showEditor && (
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() => setActiveEditorRoleId("new")}
                data-testid={`button-add-role-${userId}`}
              >
                <Plus className="h-3.5 w-3.5" />
                Add Role
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {companyRoles.length === 0 && !showEditor && (
            <p className="text-sm text-muted-foreground">No company roles assigned yet.</p>
          )}

          {companyRoles.map((role) => (
            <div key={role.id}>
              <RoleSummaryRow
                role={role}
                companyName={companies.find((c) => c.id === role.companyId)?.name || `Company ${role.companyId}`}
                locationNames={getLocationNames(role)}
                isEditing={activeEditorRoleId === role.id}
                onEdit={() => setActiveEditorRoleId((prev) => (prev === role.id ? null : role.id))}
                onDelete={() => setRoleToDelete(role)}
              />

              {role.role === "POS" && Number(role.companyId) === Number(selectedCompany?.id) && (
                <div className="mt-2">
                  <PosInventoryCostAccessToggle userId={userId} companyId={Number(role.companyId)} />
                </div>
              )}

              {role.role === "POS" && selectedCompany?.id && Number(role.companyId) !== Number(selectedCompany.id) && (
                <p className="mt-1.5 px-1 text-xs text-muted-foreground">
                  Switch to {companies.find((c) => c.id === role.companyId)?.name || `Company ${role.companyId}`} to manage
                  this POS user's cost-price access.
                </p>
              )}

              {activeEditorRoleId === role.id && (
                <div className="mt-2">
                  <InlineRoleEditor
                    userId={userId}
                    companies={companies}
                    editingRole={activeEditingRole}
                    onClose={() => setActiveEditorRoleId(null)}
                    onSaved={() => setActiveEditorRoleId(null)}
                  />
                </div>
              )}
            </div>
          ))}

          {activeEditorRoleId === "new" && (
            <InlineRoleEditor
              userId={userId}
              companies={companies}
              editingRole={null}
              onClose={() => setActiveEditorRoleId(null)}
              onSaved={() => setActiveEditorRoleId(null)}
            />
          )}
        </CardContent>
      </Card>

      <AlertDialog
        open={!!roleToDelete}
        onOpenChange={(v) => {
          if (!v) setRoleToDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this role?</AlertDialogTitle>
            <AlertDialogDescription>
              Remove the <strong>{roleToDelete?.role}</strong> role from{" "}
              <strong>
                {companies.find((c) => c.id === roleToDelete?.companyId)?.name || `Company ${roleToDelete?.companyId}`}
              </strong>
              ?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteRoleMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => roleToDelete && deleteRoleMutation.mutate(roleToDelete.id)}
              disabled={deleteRoleMutation.isPending}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-confirm-delete-role"
            >
              {deleteRoleMutation.isPending ? "Removing…" : "Remove Role"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}