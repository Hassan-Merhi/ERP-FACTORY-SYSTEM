import { useState, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Check, X, Zap } from "lucide-react";
import { ConfirmPasswordDialog, PermissionSummaryCard } from "./InlineRoleEditorSections";
import { PosLocationManager } from "./PosLocationManager";
import type { Company, LedgerAccount, Location, UserCompanyRole } from "@shared/schema";

const ROLE_OPTIONS = ["Admin", "Owner", "Manager", "POS", "Normal User", "View Only"];

interface RolePreset {
  label: string;
  values: { daybookEditDays?: number; canSellNegativeStock?: boolean; canDeleteRecords?: boolean };
}

const ROLE_PRESETS: Record<string, RolePreset[]> = {
  Manager: [
    { label: "Read-only", values: { daybookEditDays: 0, canSellNegativeStock: false, canDeleteRecords: false } },
    { label: "Standard", values: { daybookEditDays: 3, canSellNegativeStock: false, canDeleteRecords: true } },
    { label: "Power", values: { daybookEditDays: 30, canSellNegativeStock: true, canDeleteRecords: true } },
  ],
  Owner: [
    { label: "Standard", values: { daybookEditDays: 7 } },
    { label: "Unrestricted", values: { daybookEditDays: 365 } },
  ],
  "Normal User": [
    { label: "View only", values: { daybookEditDays: 0 } },
    { label: "Standard", values: { daybookEditDays: 3 } },
  ],
  POS: [
    { label: "Standard Cashier", values: { daybookEditDays: 0, canSellNegativeStock: false } },
    { label: "Senior Cashier", values: { daybookEditDays: 1, canSellNegativeStock: true } },
  ],
};

interface InlineRoleEditorProps {
  userId: string;
  companies: Company[];
  editingRole: UserCompanyRole | null;
  onClose: () => void;
  onSaved: () => void;
}

export function InlineRoleEditor({ userId, companies, editingRole, onClose, onSaved }: InlineRoleEditorProps) {
  const { toast } = useToast();
  const isEditing = !!editingRole;

  const [companyId, setCompanyId] = useState<number>(companies[0]?.id ?? 0);
  const [role, setRole] = useState("Manager");
  const [assignedLocationId, setAssignedLocationId] = useState<number | undefined>();
  const [selectedLocationIds, setSelectedLocationIds] = useState<number[]>([]);
  const [locationCashAccounts, setLocationCashAccounts] = useState<Record<number, number | undefined>>({});
  const [posStation, setPosStation] = useState<number | undefined>();
  const [daybookEditDays, setDaybookEditDays] = useState(0);
  const [canSellNegativeStock, setCanSellNegativeStock] = useState(false);
  const [posViewOnly, setPosViewOnly] = useState(false);
  const [canDeleteRecords, setCanDeleteRecords] = useState(false);
  const [confirmPasswordOpen, setConfirmPasswordOpen] = useState(false);

  const isPOS = role === "POS";

  // Determine if the current save action needs password re-confirmation
  const isDangerousSave = role === "Admin" || canDeleteRecords;

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
      setCompanyId(companies[0]?.id ?? 0);
      setRole("Manager");
      setAssignedLocationId(undefined);
      setSelectedLocationIds([]);
      setLocationCashAccounts({});
      setPosStation(undefined);
      setDaybookEditDays(0);
      setCanSellNegativeStock(false);
      setPosViewOnly(false);
      setCanDeleteRecords(false);
    }
  }, [companies, editingRole, editingRole?.id]);

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
        daybookEditDays,
        cashAccountId: undefined,
        canSellNegativeStock: canSellNegativeStock,
        posViewOnly: isPOS ? posViewOnly : false,
        canDeleteRecords: role === "Manager" ? canDeleteRecords : false,
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
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const _toggleLocation = (locId: number) => {
    setSelectedLocationIds((prev) => {
      const isRemoving = prev.includes(locId);
      const next = isRemoving ? prev.filter((id) => id !== locId) : [...prev, locId];
      if (next.length > 0) setAssignedLocationId(next[0]);
      if (isRemoving) {
        setLocationCashAccounts((c) => {
          const copy = { ...c };
          delete copy[locId];
          return copy;
        });
      }
      return next;
    });
  };

  const _selectAllLocations = () => {
    const all = locations.map((l) => l.id);
    setSelectedLocationIds(all);
    if (all.length > 0) setAssignedLocationId(all[0]);
  };

  const _clearLocations = () => {
    setSelectedLocationIds([]);
    setAssignedLocationId(undefined);
    setLocationCashAccounts({});
  };

  return (
    <div className="rounded-md border border-primary/30 bg-accent/20 p-4 space-y-4" data-testid="inline-role-editor">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {isEditing ? "Edit Role" : "Add Role"}
      </p>

      {/* Group 1: Basic Role */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Company</Label>
          <Select value={companyId.toString()} onValueChange={(v) => setCompanyId(parseInt(v))} disabled={isEditing}>
            <SelectTrigger className="h-8 text-xs" data-testid="select-role-company">
              <SelectValue placeholder="Select company" />
            </SelectTrigger>
            <SelectContent>
              {companies.map((c) => (
                <SelectItem key={c.id} value={c.id.toString()}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Role</Label>
          <Select
            value={role}
            onValueChange={(v) => {
              setRole(v);
              setSelectedLocationIds([]);
              setLocationCashAccounts({});
            }}
          >
            <SelectTrigger className="h-8 text-xs" data-testid="select-role-type">
              <SelectValue placeholder="Select role" />
            </SelectTrigger>
            <SelectContent>
              {ROLE_OPTIONS.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Group 2: POS Settings */}
      {isPOS && (
        <div className="space-y-3 rounded-md border border-border/60 bg-background p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">POS Settings</p>

          {/* Locations with per-location cash accounts */}
          <PosLocationManager
            locations={locations}
            selectedLocationIds={selectedLocationIds}
            setSelectedLocationIds={setSelectedLocationIds}
            setAssignedLocationId={setAssignedLocationId}
            locationCashAccounts={locationCashAccounts}
            setLocationCashAccounts={setLocationCashAccounts}
            posViewOnly={posViewOnly}
            cashAccounts={cashAccounts}
          />

          {/* POS Station + Daybook Days */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">POS Station</Label>
              <Input
                type="number"
                min={1}
                max={6}
                placeholder="1–6"
                value={posStation ?? ""}
                onChange={(e) => setPosStation(e.target.value ? parseInt(e.target.value) : undefined)}
                className="h-8 text-xs"
                data-testid="input-pos-station"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Daybook Edit Days</Label>
              <Input
                type="number"
                min={0}
                placeholder="0 = no edit"
                value={daybookEditDays}
                onChange={(e) => setDaybookEditDays(parseInt(e.target.value) || 0)}
                className="h-8 text-xs"
                data-testid="input-daybook-edit-days"
              />
            </div>
          </div>

          {/* Multi-Location Stock View */}
          <div className="flex items-center gap-3 rounded-md border border-border/60 bg-background px-3 py-2">
            <Switch
              checked={posViewOnly}
              onCheckedChange={(v) => setPosViewOnly(v)}
              data-testid="switch-pos-view-only"
            />
            <div className="space-y-0.5">
              <Label className="text-xs cursor-pointer">Multi-Location Stock View</Label>
              <p className="text-xs text-muted-foreground">
                User can sell from their primary location and view stock at all other assigned locations. Cash account
                required for primary location only.
              </p>
            </div>
          </div>

          {/* Allow 0-stock sales */}
          <div className="flex items-center gap-2">
            <Switch
              checked={canSellNegativeStock}
              onCheckedChange={setCanSellNegativeStock}
              data-testid="switch-can-sell-negative-stock"
            />
            <Label className="text-xs cursor-pointer">Allow 0-stock sales</Label>
          </div>
        </div>
      )}

      {/* Non-POS daybook days */}
      {!isPOS && (role === "Manager" || role === "Owner" || role === "Normal User") && (
        <div className="space-y-1.5">
          <Label className="text-xs">Daybook Edit Days</Label>
          <Input
            type="number"
            min={0}
            placeholder="0 = today only"
            value={daybookEditDays}
            onChange={(e) => setDaybookEditDays(parseInt(e.target.value) || 0)}
            className="h-8 text-xs"
            data-testid="input-daybook-edit-days"
          />
          <p className="text-xs text-muted-foreground">
            {role === "Owner"
              ? "How many past days this Owner can edit records. 0 = today only."
              : "How many past days this user can edit records. 0 = today only."}
          </p>
        </div>
      )}

      {/* Manager-only: allow delete/void/archive */}
      {role === "Manager" && (
        <div className="flex items-center gap-3 rounded-md border border-border/60 bg-background px-3 py-2">
          <Switch
            checked={canDeleteRecords}
            onCheckedChange={setCanDeleteRecords}
            data-testid="switch-can-delete-records"
          />
          <div className="space-y-0.5">
            <Label className="text-xs cursor-pointer">Allow Delete / Void / Archive</Label>
            <p className="text-xs text-muted-foreground">
              When enabled, this Manager can delete, void, and archive records.
            </p>
          </div>
        </div>
      )}

      {/* Presets */}
      {activePresets.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Zap className="h-3 w-3" />
            <span className="font-semibold uppercase tracking-wide">Quick presets</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {activePresets.map((preset) => (
              <Button
                key={preset.label}
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-xs px-2.5"
                onClick={() => applyPreset(preset.values)}
                data-testid={`button-preset-${preset.label.toLowerCase().replace(/\s+/g, "-")}`}
              >
                {preset.label}
              </Button>
            ))}
          </div>
        </div>
      )}

      {/* Permission preview */}
      <PermissionSummaryCard
        role={role}
        canDeleteRecords={canDeleteRecords}
        canSellNegativeStock={canSellNegativeStock}
        daybookEditDays={daybookEditDays}
      />

      {/* Footer */}
      <div className="flex items-center justify-end gap-2 border-t pt-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onClose}
          disabled={saveMutation.isPending}
          data-testid="button-cancel-role"
        >
          <X className="h-3.5 w-3.5 mr-1" />
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={handleSave}
          disabled={saveMutation.isPending || (isPOS && selectedLocationIds.length === 0 && !posViewOnly)}
          data-testid="button-save-role"
        >
          <Check className="h-3.5 w-3.5 mr-1" />
          {saveMutation.isPending ? "Saving…" : isEditing ? "Save Changes" : "Add Role"}
        </Button>
      </div>

      <ConfirmPasswordDialog
        open={confirmPasswordOpen}
        onClose={() => setConfirmPasswordOpen(false)}
        onConfirmed={() => {
          setConfirmPasswordOpen(false);
          saveMutation.mutate();
        }}
        action={role === "Admin" ? "Grant Admin access" : "Enable delete / void permissions"}
        description={
          role === "Admin"
            ? "Admin role grants full system access including deletions, exports, and user management."
            : "Delete permission allows this Manager to permanently remove records."
        }
      />
    </div>
  );
}
