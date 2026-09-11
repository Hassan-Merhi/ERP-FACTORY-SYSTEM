import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { UserPlus, Users } from "lucide-react";
import { UserListTable } from "./UserListTable";
import { UserManagementDrawer } from "./UserManagementDrawer";
import { AddUserDialog } from "./AddUserDialog";
import type { SettingsUserRow } from "../settingsTypes";
import type { Company } from "@shared/schema";

export function UsersSection() {
  const [selectedUser, setSelectedUser] = useState<SettingsUserRow | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [addDialogOpen, setAddDialogOpen] = useState(false);

  const { data: rawUsers = [], isLoading } = useQuery<SettingsUserRow[]>({
    queryKey: ["/api/users"],
  });
  const users = [...rawUsers].sort((a, b) =>
    (a.displayName || a.username || "").localeCompare(b.displayName || b.username || "")
  );

  const { data: companies = [] } = useQuery<Company[]>({
    queryKey: ["/api/companies"],
  });

  const openDrawer = (user: SettingsUserRow) => {
    setSelectedUser(user);
    setDrawerOpen(true);
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    setSelectedUser(null);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-semibold flex items-center gap-2" data-testid="text-users-title">
            <Users className="h-6 w-6" />
            User Management
          </h2>
          <p className="text-muted-foreground mt-1">Select a user to manage their account, access, and permissions.</p>
        </div>
        <Button onClick={() => setAddDialogOpen(true)} data-testid="button-add-user">
          <UserPlus className="h-4 w-4 mr-2" />
          Add User
        </Button>
      </div>

      <UserListTable users={users} isLoading={isLoading} selectedUserId={selectedUser?.id} onSelectUser={openDrawer} />

      <UserManagementDrawer
        // The drawer renders nothing until a user is selected; the assertion only
        // satisfies the prop type while it is closed.
        user={selectedUser!}
        open={drawerOpen}
        onClose={closeDrawer}
        companies={companies}
        onUserDeleted={closeDrawer}
      />

      <AddUserDialog open={addDialogOpen} onOpenChange={setAddDialogOpen} />
    </div>
  );
}
