import { useState } from "react";
import { z } from "zod";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

import { useQuery } from "@tanstack/react-query";
import { Building2, Loader2, Eye } from "lucide-react";
import { insertUserSchema, insertCompanySchema, insertUserCompanyRoleSchema, userPresence } from "@shared/schema";

const _userFormSchema = insertUserSchema;
const _companyFormSchema = insertCompanySchema;
const _roleAssignmentSchema = insertUserCompanyRoleSchema.refine(
  (data) => {
    // If role is POS, assignedLocationId must be present
    if (data.role === "POS" && !data.assignedLocationId) {
      return false;
    }
    return true;
  },
  {
    message: "POS roles require an assigned location",
    path: ["assignedLocationId"],
  }
);

type _UserFormData = z.infer<typeof _userFormSchema>;
type _CompanyFormData = z.infer<typeof _companyFormSchema>;
type _RoleAssignmentData = z.infer<typeof _roleAssignmentSchema>;

import { getPageLabel } from "./WatchUserDialog";
import { RemoteSupportWatchDialog } from "./RemoteSupportWatchDialog";
import type { AuthMe } from "@shared/apiTypes";

export function ActiveUsersSection() {
  const [watchingUser, setWatchingUser] = useState<{ userId: string; username: string } | null>(null);

  const { data: currentUser } = useQuery<AuthMe>({ queryKey: ["/api/auth/me"] });
  const isDeveloper = currentUser?.role === "Developer";

  type PresenceRow = typeof userPresence.$inferSelect;

  const { data: presenceData, isLoading } = useQuery<PresenceRow[]>({
    queryKey: ["/api/user-presence"],
    refetchInterval: 30000,
  });

  const { data: companies } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["/api/companies"],
  });

  const formatTimeAgo = (dateStr: string | Date) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return "Just now";
    if (diffMins === 1) return "1 min ago";
    if (diffMins < 60) return `${diffMins} mins ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours === 1) return "1 hour ago";
    return `${diffHours} hours ago`;
  };

  const getCompanyName = (companyId: number | null) => {
    if (!companyId || !companies) return "—";
    const company = companies.find((c) => c.id === companyId);
    return company?.name || "Unknown";
  };

  // Group users by company
  const safePresenceData = Array.isArray(presenceData) ? presenceData : [];
  const groupedUsers = safePresenceData.reduce<Record<string, PresenceRow[]>>((acc, presence) => {
    const companyId = presence.companyId || "unassigned";
    if (!acc[companyId]) {
      acc[companyId] = [];
    }
    acc[companyId].push(presence);
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Eye className="h-5 w-5" />
        <h2 className="text-2xl font-semibold">Active Users</h2>
      </div>
      <p className="text-muted-foreground">Monitor currently active users and their location in the application.</p>

      {isLoading ? (
        <Card className="p-6">
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Loading active users...</span>
          </div>
        </Card>
      ) : safePresenceData.length === 0 ? (
        <Card className="p-6">
          <p className="text-muted-foreground">No active users at the moment.</p>
        </Card>
      ) : (
        <div className="space-y-4">
          {Object.entries(groupedUsers).map(([companyId, users]) => (
            <Card key={companyId} className="overflow-hidden">
              <div className="px-4 py-3 bg-muted/50 border-b">
                <div className="flex items-center gap-2">
                  <Building2 className="h-4 w-4" />
                  <h3 className="font-medium">
                    {companyId === "unassigned" ? "No Company Selected" : getCompanyName(Number(companyId))}
                  </h3>
                  <Badge variant="secondary" className="ml-2">
                    {users.length}
                  </Badge>
                </div>
              </div>
              {/* Desktop table */}
              <div className="hidden sm:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>User</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Current Page</TableHead>
                      <TableHead>Last Active</TableHead>
                      <TableHead className="w-16" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {users.map((presence) => (
                      <TableRow key={presence.id} data-testid={`row-presence-${presence.id}`}>
                        <TableCell className="font-medium">{presence.username}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{presence.role || "—"}</Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{getPageLabel(presence.currentRoute)}</TableCell>
                        <TableCell className="text-muted-foreground">{formatTimeAgo(presence.lastSeen)}</TableCell>
                        {isDeveloper && (
                          <TableCell>
                            <Button
                              size="sm"
                              variant="ghost"
                              data-testid={`button-watch-${presence.userId}`}
                              disabled={!presence.userId}
                              onClick={() =>
                                presence.userId &&
                                setWatchingUser({ userId: String(presence.userId), username: presence.username })
                              }
                            >
                              <Eye className="h-3.5 w-3.5 mr-1" />
                              Watch
                            </Button>
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {/* Mobile card list */}
              <div className="sm:hidden divide-y">
                {users.map((presence) => (
                  <div key={presence.id} data-testid={`row-presence-${presence.id}`} className="p-3 space-y-1">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <span className="font-medium text-sm">{presence.username}</span>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs">
                          {presence.role || "—"}
                        </Badge>
                        {isDeveloper && (
                          <Button
                            size="sm"
                            variant="ghost"
                            data-testid={`button-watch-mobile-${presence.userId}`}
                            disabled={!presence.userId}
                            onClick={() =>
                              presence.userId &&
                              setWatchingUser({ userId: String(presence.userId), username: presence.username })
                            }
                          >
                            <Eye className="h-3.5 w-3.5 mr-1" />
                            Watch
                          </Button>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{getPageLabel(presence.currentRoute)}</span>
                      <span>{formatTimeAgo(presence.lastSeen)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}

      {watchingUser && (
        <RemoteSupportWatchDialog
          userId={watchingUser.userId}
          username={watchingUser.username}
          onClose={() => setWatchingUser(null)}
        />
      )}
    </div>
  );
}

// Data Tools Tab component - consolidates administrative utilities
