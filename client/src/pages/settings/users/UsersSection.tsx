import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { UserPlus } from "lucide-react";
import { UserListTable } from "./UserListTable";
import { UserManagementDrawer } from "./UserManagementDrawer";
import { AddUserDialog } from "./AddUserDialog";
import type { SettingsUserRow } from "../settingsTypes";
import type { Company } from "@shared/schema";

interface UsersSectionProps {
  appMode?: string;
}

export function UsersSection({ appMode }: UsersSectionProps) {
  const [selectedUser, setSelectedUser] = useState<SettingsUserRow | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [addDialogOpen, setAddDialogOpen] = useState(false);

  const usersEndpoint = appMode === "factory" ? "/api/factory/users" : "/api/users";
  const { data: rawUsers = [], isLoading } = useQuery<SettingsUserRow[]>({
    queryKey: [usersEndpoint],
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
        {/* The Users & Permissions hub owns the section title; this panel keeps only its guidance. */}
        <p className="text-muted-foreground" data-testid="text-users-intro">
          Select a user to manage their account, access, and permissions.
        </p>
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
