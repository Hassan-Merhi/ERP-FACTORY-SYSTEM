import { Users } from "lucide-react";
import { UsersSection } from "./UsersSection";

interface UsersPermissionsHubProps {
  userRole?: string;
  appMode?: string;
}

export function UsersPermissionsHub({ userRole: _userRole, appMode }: UsersPermissionsHubProps) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold flex items-center gap-2">
          <Users className="h-6 w-6" />
          Users &amp; Permissions
        </h2>
        <p className="text-muted-foreground text-sm mt-1">Manage users and role assignments.</p>
      </div>

      <UsersSection appMode={appMode} />
    </div>
  );
}
