import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
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
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Shield, Save } from "lucide-react";
import { UserManagementForm } from "./UserManagementForm";
import { useUserManagementDrawerState, type UserManagementDrawerProps } from "./useUserManagementDrawerState";

export function UserManagementDrawer({ user, open, onClose, companies, onUserDeleted }: UserManagementDrawerProps) {
  const {
    requestPasswordConfirmation,
    PasswordConfirmationDialog,
    isPrivileged,
    isViewOnly,
    username,
    setUsername,
    displayName,
    setDisplayName,
    hasErpAccess,
    setHasErpAccess,
    hasFactoryAccess,
    setHasFactoryAccess,
    pageAccess,
    setPageAccess,
    hiddenCostFields,
    setHiddenCostFields,
    hiddenErpCostFields,
    setHiddenErpCostFields,
    newPassword,
    setNewPassword,
    setConfirmDelete,
    confirmDelete,
    openTabGroups,
    updateMutation,
    deleteMutation,
    saveErpRestrictionsMutation,
    toggleTabGroup,
    isDirty,
    handleSaveAll,
    handleDiscard,
  } = useUserManagementDrawerState({ user, onUserDeleted });

  if (!user) return null;

  const accessLabel =
    (isPrivileged || hasErpAccess) && (isPrivileged || hasFactoryAccess)
      ? "ERP + Factory"
      : isPrivileged || hasErpAccess
        ? "ERP only"
        : isPrivileged || hasFactoryAccess
          ? "Factory only"
          : "No access";

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(v) => {
          if (!v) onClose();
        }}
      >
        <SheetContent side="right" className="w-full sm:max-w-[520px] p-0 flex flex-col">
          <SheetHeader className="px-6 py-4 border-b shrink-0">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted font-bold text-base uppercase text-muted-foreground">
                {(user.displayName || user.username).charAt(0)}
              </div>
              <div className="flex-1 min-w-0">
                <SheetTitle className="text-lg leading-tight">{user.displayName || user.username}</SheetTitle>
                {user.displayName && (
                  <SheetDescription className="font-mono text-xs mt-0">{user.username}</SheetDescription>
                )}
              </div>
              {isPrivileged && (
                <Badge variant="default" className="capitalize gap-1 shrink-0">
                  <Shield className="h-3 w-3" />
                  {user.role}
                </Badge>
              )}
              {isViewOnly && (
                <Badge
                  variant="outline"
                  className="gap-1 shrink-0 border-sky-300 bg-sky-100 text-sky-700 dark:border-sky-700 dark:bg-sky-950 dark:text-sky-300"
                >
                  View Only
                </Badge>
              )}
            </div>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto">
            <UserManagementForm
              user={user}
              username={username}
              setUsername={setUsername}
              displayName={displayName}
              setDisplayName={setDisplayName}
              newPassword={newPassword}
              setNewPassword={setNewPassword}
              hasErpAccess={hasErpAccess}
              setHasErpAccess={setHasErpAccess}
              hasFactoryAccess={hasFactoryAccess}
              setHasFactoryAccess={setHasFactoryAccess}
              isPrivileged={isPrivileged}
              isViewOnly={isViewOnly}
              accessLabel={accessLabel}
              companies={companies}
              setConfirmDelete={setConfirmDelete}
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

          {isDirty && (
            <div className="shrink-0 border-t px-6 py-3 bg-background flex items-center justify-between gap-3 flex-wrap z-50">
              <p className="text-xs text-muted-foreground">
                {newPassword ? "Unsaved changes · includes new password" : "Unsaved changes"}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDiscard}
                  disabled={updateMutation.isPending || saveErpRestrictionsMutation.isPending}
                  data-testid="button-discard-changes"
                >
                  Discard
                </Button>
                <Button
                  size="sm"
                  className="gap-2"
                  onClick={handleSaveAll}
                  disabled={updateMutation.isPending || saveErpRestrictionsMutation.isPending}
                  data-testid="button-save-all-changes"
                >
                  <Save className="h-3.5 w-3.5" />
                  {updateMutation.isPending || saveErpRestrictionsMutation.isPending ? "Saving…" : "Save changes"}
                </Button>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {user.username}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will deactivate their account. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmDelete(false);
                requestPasswordConfirmation(() => deleteMutation.mutate(), "Remove User");
              }}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-confirm-delete-user"
            >
              {deleteMutation.isPending ? "Removing..." : "Remove User"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {PasswordConfirmationDialog}
    </>
  );
}
