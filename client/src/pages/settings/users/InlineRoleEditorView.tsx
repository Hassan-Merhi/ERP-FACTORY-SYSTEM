// Extracted from ./InlineRoleEditor.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Check, X, Zap } from "lucide-react";
import { ConfirmPasswordDialog, PermissionSummaryCard } from "./InlineRoleEditorSections";
import { CREATE_ONLY_ROLE, type InlineRoleEditorProps } from "./InlineRoleEditorROLE_PRESETS";
import { useInlineRoleEditorState } from "./useInlineRoleEditorState";
import { InlineRoleEditorContent } from "./InlineRoleEditorContent";

export function InlineRoleEditor({ userId, companies, editingRole, onClose, onSaved }: InlineRoleEditorProps) {
  const {
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
  } = useInlineRoleEditorState({ userId, companies, editingRole, onSaved });

  return (
    <div className="rounded-md border border-primary/30 bg-accent/20 p-4 space-y-4" data-testid="inline-role-editor">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {isEditing ? "Edit Role" : "Add Role"}
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
              if (v === "View Only" || v === CREATE_ONLY_ROLE) {
                setCanDeleteRecords(false);
                setCanSellNegativeStock(false);
                setDaybookEditDays(0);
              }
              setSelectedLocationIds([]);
              setLocationCashAccounts({});
            }}
          >
            <SelectTrigger className="h-8 text-xs" data-testid="select-role-type">
              <SelectValue placeholder="Select role" />
            </SelectTrigger>
            <SelectContent>
              {roleOptions.map((r) => (
                <SelectItem key={r} value={r}>
                  {r === "View Only" ? "View Only (ERP + Factory)" : r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {role === "View Only" && (
        <p className="text-xs text-muted-foreground" data-testid="view-only-erp-factory-description">
          Read-only access for this company in both ERP and Factory (when app access is enabled). All ERP business-data
          pages are browseable except Dashboard, Settings, and Create Voucher. Factory access remains subject to its
          page permissions. Creating, editing, importing, deleting, and posting are blocked.
        </p>
      )}

      {isCreateOnly && (
        <p className="text-xs text-muted-foreground" data-testid="create-only-role-description">
          Can browse company data and add approved new records. Cannot edit, delete, approve, void, reverse or import
          any existing record, including records this user created.
        </p>
      )}

      {outsideActiveCompany && (
        <p className="text-xs text-destructive" role="alert" data-testid="role-company-scope-warning">
          Switch to this company before assigning its role. Only Developer accounts can manage another company from the
          current workspace.
        </p>
      )}

      {isTester && (
        <p className="text-xs text-muted-foreground">
          ERP Tester can be assigned to any company. This user can enter operational data in assigned companies but has
          no access to Settings or user administration.
        </p>
      )}

      {isPOS && (
        <InlineRoleEditorContent
          canAccessCustomers={canAccessCustomers}
          canSellNegativeStock={canSellNegativeStock}
          cashAccounts={cashAccounts}
          daybookEditDays={daybookEditDays}
          locationCashAccounts={locationCashAccounts}
          locations={locations}
          posStation={posStation}
          posViewOnly={posViewOnly}
          selectedLocationIds={selectedLocationIds}
          setAssignedLocationId={setAssignedLocationId}
          setCanAccessCustomers={setCanAccessCustomers}
          setCanSellNegativeStock={setCanSellNegativeStock}
          setDaybookEditDays={setDaybookEditDays}
          setLocationCashAccounts={setLocationCashAccounts}
          setPosStation={setPosStation}
          setPosViewOnly={setPosViewOnly}
          setSelectedLocationIds={setSelectedLocationIds}
        />
      )}

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

      {(role === "Manager" || isTester) && (
        <div className="flex items-center gap-3 rounded-md border border-border/60 bg-background px-3 py-2">
          <Switch
            checked={canDeleteRecords}
            onCheckedChange={setCanDeleteRecords}
            data-testid="switch-can-delete-records"
          />
          <div className="space-y-0.5">
            <Label className="text-xs cursor-pointer">Allow Delete / Void / Archive</Label>
            <p className="text-xs text-muted-foreground">
              When enabled, this user can delete, void, and archive records within their assigned company.
            </p>
          </div>
        </div>
      )}

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

      <PermissionSummaryCard
        role={role}
        canDeleteRecords={canDeleteRecords}
        canSellNegativeStock={canSellNegativeStock}
        canAccessCustomers={isPOS ? canAccessCustomers : Boolean(editingRole?.canAccessCustomers)}
        daybookEditDays={daybookEditDays}
      />

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
          disabled={
            saveMutation.isPending ||
            outsideActiveCompany ||
            (isPOS && selectedLocationIds.length === 0 && !posViewOnly)
          }
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
