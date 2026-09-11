import { useState } from "react";
import { User, Trash2, X, KeyRound, Lock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { UserRolesCard } from "./UserRolesCard";
import { AdvancedRestrictions } from "./AdvancedRestrictions";
import type { SettingsUserRow } from "../settingsTypes";
import type { Company } from "@shared/schema";

interface UserManagementFormProps {
  user: SettingsUserRow;
  username: string;
  setUsername: (v: string) => void;
  displayName: string;
  setDisplayName: (v: string) => void;
  newPassword: string;
  setNewPassword: (v: string) => void;
  hasErpAccess: boolean;
  setHasErpAccess: (v: boolean) => void;
  hasFactoryAccess: boolean;
  setHasFactoryAccess: (v: boolean) => void;
  isPrivileged: boolean;
  isViewOnly: boolean;
  accessLabel: string;
  companies: Company[];
  setConfirmDelete: (v: boolean) => void;
  pageAccess: Set<string>;
  hiddenCostFields: string[];
  hiddenErpCostFields: string[];
  setPageAccess: React.Dispatch<React.SetStateAction<Set<string>>>;
  setHiddenCostFields: React.Dispatch<React.SetStateAction<string[]>>;
  setHiddenErpCostFields: React.Dispatch<React.SetStateAction<string[]>>;
  openTabGroups: Set<string>;
  toggleTabGroup: (group: string) => void;
}

export function UserManagementForm({
  user,
  username,
  setUsername,
  displayName,
  setDisplayName,
  newPassword,
  setNewPassword,
  hasErpAccess,
  setHasErpAccess,
  hasFactoryAccess,
  setHasFactoryAccess,
  isPrivileged,
  isViewOnly,
  accessLabel,
  companies,
  setConfirmDelete,
  pageAccess,
  hiddenCostFields,
  hiddenErpCostFields,
  setPageAccess,
  setHiddenCostFields,
  setHiddenErpCostFields,
  openTabGroups,
  toggleTabGroup,
}: UserManagementFormProps) {
  const [showPasswordReset, setShowPasswordReset] = useState(false);

  return (
    <div className="px-6 py-4 space-y-4 pb-6">
      {/* Card 1: Account */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <User className="h-4 w-4" />
            Account
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Username</Label>
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                data-testid="input-drawer-username"
              />
              {username !== user.username && <p className="text-xs text-muted-foreground">Will change on save</p>}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Display Name</Label>
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Optional friendly name"
                data-testid="input-drawer-display-name"
              />
            </div>
          </div>

          {showPasswordReset ? (
            <div className="space-y-1.5">
              <Label className="text-xs">New Password</Label>
              <div className="flex gap-2">
                <Input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Enter new password"
                  data-testid="input-drawer-new-password"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => {
                    setNewPassword("");
                    setShowPasswordReset(false);
                  }}
                  data-testid="button-cancel-password-reset"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => setShowPasswordReset(true)}
              data-testid="button-show-password-reset"
            >
              <KeyRound className="h-3.5 w-3.5" />
              Reset Password
            </Button>
          )}

          {!isPrivileged && (
            <div className="pt-1">
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive gap-2"
                onClick={() => setConfirmDelete(true)}
                data-testid="button-delete-user"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Remove User
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Card 2: App Access */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Lock className="h-4 w-4" />
            App Access
            <Badge variant="secondary" className="ml-auto text-xs font-normal">
              {accessLabel}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {isPrivileged ? (
            <p className="text-xs text-muted-foreground rounded-md bg-muted/40 px-3 py-2.5">
              <strong>{user.role}</strong> accounts always have full access to both ERP and Factory — this cannot be
              restricted.
            </p>
          ) : isViewOnly ? (
            <>
              <p className="text-xs rounded-md bg-sky-50 dark:bg-sky-950/40 border border-sky-200 dark:border-sky-800 px-3 py-2.5 text-sky-700 dark:text-sky-300">
                This user can only view data — all write actions are blocked. Use the toggles below to choose which
                sections they can access. If both are on, they can view everything.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex items-center justify-between rounded-md border p-3">
                  <div>
                    <p className="text-sm font-medium">ERP</p>
                    <p className="text-xs text-muted-foreground">Accounting &amp; sales</p>
                  </div>
                  <Switch
                    checked={hasErpAccess}
                    onCheckedChange={setHasErpAccess}
                    data-testid="switch-drawer-erp-access"
                  />
                </div>
                <div className="flex items-center justify-between rounded-md border p-3">
                  <div>
                    <p className="text-sm font-medium">Factory</p>
                    <p className="text-xs text-muted-foreground">Production &amp; bales</p>
                  </div>
                  <Switch
                    checked={hasFactoryAccess}
                    onCheckedChange={setHasFactoryAccess}
                    data-testid="switch-drawer-factory-access"
                  />
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex items-center justify-between rounded-md border p-3">
                  <div>
                    <p className="text-sm font-medium">ERP</p>
                    <p className="text-xs text-muted-foreground">Accounting &amp; sales</p>
                  </div>
                  <Switch
                    checked={hasErpAccess}
                    onCheckedChange={setHasErpAccess}
                    data-testid="switch-drawer-erp-access"
                  />
                </div>
                <div className="flex items-center justify-between rounded-md border p-3">
                  <div>
                    <p className="text-sm font-medium">Factory</p>
                    <p className="text-xs text-muted-foreground">Production &amp; bales</p>
                  </div>
                  <Switch
                    checked={hasFactoryAccess}
                    onCheckedChange={setHasFactoryAccess}
                    data-testid="switch-drawer-factory-access"
                  />
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Card 3: Company Roles — inline editing, no modal */}
      <UserRolesCard userId={user?.id} companies={companies} />

      {/* Card 4: Advanced Restrictions */}
      <AdvancedRestrictions
        user={user}
        isPrivileged={isPrivileged}
        hasFactoryAccess={hasFactoryAccess}
        hasErpAccess={hasErpAccess}
        pageAccess={pageAccess}
        hiddenCostFields={hiddenCostFields}
        hiddenErpCostFields={hiddenErpCostFields}
        setPageAccess={setPageAccess}
        setHiddenCostFields={setHiddenCostFields}
        setHiddenErpCostFields={setHiddenErpCostFields}
        openTabGroups={openTabGroups}
        toggleTabGroup={toggleTabGroup}
      />
    </div>
  );
}
