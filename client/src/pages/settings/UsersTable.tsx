import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Edit, Trash2, Key } from "lucide-react";
import type { SettingsUserRow } from "./settingsTypes";

interface UsersTableProps {
  users: SettingsUserRow[];
  onEdit: (user: Record<string, unknown>) => void;
  onDelete: (user: Record<string, unknown>) => void;
  onResetPassword: (user: Record<string, unknown>) => void;
}

export function UsersTable({ users, onEdit, onDelete, onResetPassword }: UsersTableProps) {
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Username</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((user) => (
            <TableRow key={user.id}>
              <TableCell className="font-medium">{user.username}</TableCell>
              <TableCell>
                <Badge variant="outline" className="capitalize">
                  {user.role || "Normal User"}
                </Badge>
              </TableCell>
              <TableCell>
                <Badge variant={user.active ? "default" : "secondary"}>{user.active ? "Active" : "Inactive"}</Badge>
              </TableCell>
              <TableCell className="text-right space-x-2">
                <Button size="icon" variant="ghost" onClick={() => onResetPassword(user)} title="Reset Password">
                  <Key className="h-4 w-4" />
                </Button>
                <Button size="icon" variant="ghost" onClick={() => onEdit(user)}>
                  <Edit className="h-4 w-4" />
                </Button>
                <Button size="icon" variant="ghost" onClick={() => onDelete(user)}>
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
