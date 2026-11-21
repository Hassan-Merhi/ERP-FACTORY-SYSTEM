// Extracted from ./InlineRoleEditorView.tsx
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { PosLocationManager } from "./PosLocationManager";
import { PosCustomerPermissionSwitch } from "./PosCustomerPermissionSwitch";
import { useInlineRoleEditorState } from "./useInlineRoleEditorState";

export function InlineRoleEditorContent({
  canAccessCustomers,
  canSellNegativeStock,
  cashAccounts,
  daybookEditDays,
  locationCashAccounts,
  locations,
  posStation,
  posViewOnly,
  selectedLocationIds,
  setAssignedLocationId,
  setCanAccessCustomers,
  setCanSellNegativeStock,
  setDaybookEditDays,
  setLocationCashAccounts,
  setPosStation,
  setPosViewOnly,
  setSelectedLocationIds,
}: Pick<
  ReturnType<typeof useInlineRoleEditorState>,
  | "canAccessCustomers"
  | "canSellNegativeStock"
  | "cashAccounts"
  | "daybookEditDays"
  | "locationCashAccounts"
  | "locations"
  | "posStation"
  | "posViewOnly"
  | "selectedLocationIds"
  | "setAssignedLocationId"
  | "setCanAccessCustomers"
  | "setCanSellNegativeStock"
  | "setDaybookEditDays"
  | "setLocationCashAccounts"
  | "setPosStation"
  | "setPosViewOnly"
  | "setSelectedLocationIds"
>) {
  return (
    <div className="space-y-3 rounded-md border border-border/60 bg-background p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">POS Settings</p>

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

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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

      <div className="flex items-center gap-3 rounded-md border border-border/60 bg-background px-3 py-2">
        <Switch checked={posViewOnly} onCheckedChange={(v) => setPosViewOnly(v)} data-testid="switch-pos-view-only" />
        <div className="space-y-0.5">
          <Label className="text-xs cursor-pointer">Multi-Location Stock View</Label>
          <p className="text-xs text-muted-foreground">
            User can sell from their primary location and view stock at all other assigned locations. Cash account
            required for primary location only.
          </p>
        </div>
      </div>

      <PosCustomerPermissionSwitch enabled={canAccessCustomers} onChange={setCanAccessCustomers} />

      <div className="flex items-center gap-2">
        <Switch
          checked={canSellNegativeStock}
          onCheckedChange={setCanSellNegativeStock}
          data-testid="switch-can-sell-negative-stock"
        />
        <Label className="text-xs cursor-pointer">Allow 0-stock sales</Label>
      </div>
    </div>
  );
}
