// Extracted from ./InlineRoleEditorView.tsx
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useCompany } from "@/contexts/CompanyContext";
import type { LedgerAccount, Location } from "@shared/schema";
import {
  CREATE_ONLY_ROLE,
  ROLE_OPTIONS,
  ROLE_PRESETS,
  type InlineRoleEditorProps,
  type RolePreset,
} from "./InlineRoleEditorROLE_PRESETS";

export function useInlineRoleEditorState({
  userId,
  companies,
  editingRole,
  onSaved,
}: Pick<InlineRoleEditorProps, "userId" | "companies" | "editingRole" | "onSaved">) {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const { data: currentUser } = useQuery<{ role?: string; currentRole?: string }>({
    queryKey: ["/api/auth/me"],
  });
  const isEditing = !!editingRole;
  const activeCompanyId = Number(selectedCompany?.id ?? 0);
  const isDeveloper = (currentUser?.currentRole ?? currentUser?.role) === "Developer";

  const [companyId, setCompanyId] = useState<number>(activeCompanyId || companies[0]?.id || 0);
  const outsideActiveCompany = activeCompanyId > 0 && companyId !== activeCompanyId && !isDeveloper;
  const [role, setRole] = useState("Manager");
  const [assignedLocationId, setAssignedLocationId] = useState<number | undefined>();
  const [selectedLocationIds, setSelectedLocationIds] = useState<number[]>([]);
  const [locationCashAccounts, setLocationCashAccounts] = useState<Record<number, number | undefined>>({});
  const [posStation, setPosStation] = useState<number | undefined>();
  const [daybookEditDays, setDaybookEditDays] = useState(0);
  const [canSellNegativeStock, setCanSellNegativeStock] = useState(false);
  const [posViewOnly, setPosViewOnly] = useState(false);
  const [canAccessCustomers, setCanAccessCustomers] = useState(false);
  const [canDeleteRecords, setCanDeleteRecords] = useState(false);
  const [confirmPasswordOpen, setConfirmPasswordOpen] = useState(false);

  const isPOS = role === "POS";
  const isTester = role === "ERP Tester";
  const isCreateOnly = role === CREATE_ONLY_ROLE;
  const { data: permissionCatalog } = useQuery<{ createOnlyAssignable?: boolean }>({
    queryKey: ["/api/permissions-v2/catalog", activeCompanyId],
    enabled: activeCompanyId > 0,
    retry: false,
    staleTime: 0,
  });
  const roleOptions =
    permissionCatalog?.createOnlyAssignable === true || editingRole?.role === CREATE_ONLY_ROLE
      ? [...ROLE_OPTIONS, CREATE_ONLY_ROLE]
      : ROLE_OPTIONS;
  const isDangerousSave = role === "Admin" || ((role === "Manager" || isTester) && canDeleteRecords);

  const handleSave = () => {
    if (isDangerousSave) {
      setConfirmPasswordOpen(true);
    } else {
      saveMutation.mutate();
    }
  };

  const applyPreset = (values: RolePreset["values"]) => {
    if (values.daybookEditDays !== undefined) setDaybookEditDays(values.daybookEditDays);
    if (values.canSellNegativeStock !== undefined) setCanSellNegativeStock(values.canSellNegativeStock);
    if (values.canDeleteRecords !== undefined) setCanDeleteRecords(values.canDeleteRecords);
  };

  const activePresets = ROLE_PRESETS[role] ?? [];

  useEffect(() => {
    if (editingRole) {
      setCompanyId(editingRole.companyId);
      setRole(editingRole.role);
      setAssignedLocationId(editingRole.assignedLocationId ?? undefined);
      setPosStation(editingRole.posStation ?? undefined);
      setDaybookEditDays(editingRole.daybookEditDays ?? 0);
      setCanSellNegativeStock(editingRole.canSellNegativeStock ?? false);
      setPosViewOnly(editingRole.posViewOnly ?? false);
      setCanAccessCustomers(editingRole.canAccessCustomers ?? false);
      setCanDeleteRecords(editingRole.canDeleteRecords ?? false);

      if (editingRole.role === "POS") {
        fetch(`/api/user-locations/${editingRole.userId}/${editingRole.companyId}`, { credentials: "include" })
          .then((r) => r.json())
          .then((locs) => {
            if (Array.isArray(locs) && locs.length > 0) {
              setSelectedLocationIds(locs.map((l) => l.locationId));
            } else {
              setSelectedLocationIds(editingRole.assignedLocationId ? [editingRole.assignedLocationId] : []);
            }
          })
          .catch(() => {
            setSelectedLocationIds(editingRole.assignedLocationId ? [editingRole.assignedLocationId] : []);
          });

        fetch(`/api/user-location-cash-accounts/${editingRole.userId}/${editingRole.companyId}`, {
          credentials: "include",
        })
          .then((r) => r.json())
          .then((mappings) => {
            if (Array.isArray(mappings)) {
              const record: Record<number, number> = {};
              mappings.forEach((m) => {
                record[m.locationId] = m.cashAccountId;
              });
              setLocationCashAccounts(record);
            }
          })
          .catch(() => {});
      } else {
        setSelectedLocationIds([]);
        setLocationCashAccounts({});
      }
    } else {
      setCompanyId(activeCompanyId || companies[0]?.id || 0);
      setRole("Manager");
      setAssignedLocationId(undefined);
      setSelectedLocationIds([]);
      setLocationCashAccounts({});
      setPosStation(undefined);
      setDaybookEditDays(0);
      setCanSellNegativeStock(false);
      setPosViewOnly(false);
      setCanAccessCustomers(false);
      setCanDeleteRecords(false);
    }
  }, [activeCompanyId, companies, editingRole, editingRole?.id]);

  const { data: locations = [] } = useQuery<Location[]>({
    queryKey: ["/api/locations", { companyId }],
    queryFn: async () => {
      if (!companyId) return [];
      const res = await fetch(`/api/locations?companyId=${companyId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch locations");
      return res.json();
    },
    enabled: !!companyId && isPOS,
  });

  const { data: ledgerAccounts = [] } = useQuery<LedgerAccount[]>({
    queryKey: ["/api/ledger-accounts", { companyId }],
    queryFn: async () => {
      if (!companyId) return [];
      const res = await fetch(`/api/ledger-accounts?companyId=${companyId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch ledger accounts");
      return res.json();
    },
    enabled: !!companyId && isPOS,
  });

  const cashAccounts = ledgerAccounts.filter((a) => a.accountType === "Cash");

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (isPOS && selectedLocationIds.length > 0) {
        // When posViewOnly, only the primary (first) location needs a cash account.
        // Without posViewOnly, all selected locations need one.
        const locationsNeedingCash = posViewOnly ? selectedLocationIds.slice(0, 1) : selectedLocationIds;
        const missing = locationsNeedingCash.filter((id) => !locationCashAccounts[id]);
        if (missing.length > 0) {
          const locNames = missing.map((id) => {
            const loc = locations.find((l) => l.id === id);
            return loc?.name || `Location #${id}`;
          });
          throw new Error(`Cash account required for: ${locNames.join(", ")}`);
        }
      }

      const primary = selectedLocationIds[0] ?? assignedLocationId;
      const payload = {
        userId,
        companyId,
        role,
        assignedLocationId: isPOS ? primary : undefined,
        posStation: isPOS ? posStation : undefined,
        // Create Only never edits existing records, so it never gets a backdating window.
        daybookEditDays: isCreateOnly ? 0 : daybookEditDays,
        cashAccountId: undefined,
        canSellNegativeStock: canSellNegativeStock,
        posViewOnly: isPOS ? posViewOnly : false,
        canAccessCustomers: isPOS ? canAccessCustomers : Boolean(editingRole?.canAccessCustomers),
        canDeleteRecords: role === "Manager" || isTester ? canDeleteRecords : false,
      };

      if (isEditing) {
        await apiRequest("PATCH", `/api/user-company-roles/${editingRole.id}`, payload);
      } else {
        await apiRequest("POST", "/api/user-company-roles", payload);
      }

      if (isPOS && selectedLocationIds.length > 0) {
        await apiRequest("PUT", `/api/user-locations/${userId}/${companyId}`, {
          locationIds: selectedLocationIds,
        });
        const mappings = selectedLocationIds
          .filter((id) => locationCashAccounts[id])
          .map((id) => ({ locationId: id, cashAccountId: locationCashAccounts[id] }));
        await apiRequest("PUT", `/api/user-location-cash-accounts/${userId}/${companyId}`, {
          mappings,
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/users/${userId}/company-roles`] });
      queryClient.invalidateQueries({ queryKey: ["/api/my-locations"] });
      toast({ title: isEditing ? "Role updated" : "Role assigned" });
      onSaved();
    },
    onError: (err: Error) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });
  return {
    isEditing,
    companyId,
    setCompanyId,
    outsideActiveCompany,
    role,
    setRole,
    setAssignedLocationId,
    setSelectedLocationIds,
    selectedLocationIds,
    setLocationCashAccounts,
    locationCashAccounts,
    posStation,
    setPosStation,
    setDaybookEditDays,
    daybookEditDays,
    setCanSellNegativeStock,
    canSellNegativeStock,
    posViewOnly,
    setPosViewOnly,
    canAccessCustomers,
    setCanAccessCustomers,
    setCanDeleteRecords,
    canDeleteRecords,
    confirmPasswordOpen,
    setConfirmPasswordOpen,
    isPOS,
    isTester,
    isCreateOnly,
    roleOptions,
    handleSave,
    applyPreset,
    activePresets,
    locations,
    cashAccounts,
    saveMutation,
  };
}
