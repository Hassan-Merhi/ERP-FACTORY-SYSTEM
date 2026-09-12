export type AppUserRole = "Admin" | "Owner" | "Developer" | "Manager" | "User" | string;

export interface ShellUser {
  id: string | number;
  username: string;
  role?: AppUserRole | null;
  posStation?: string | number | null;
}

export function canUseAdminSearch(user: Pick<ShellUser, "role">): boolean {
  return user.role === "Admin" || user.role === "Owner" || user.role === "Developer";
}
