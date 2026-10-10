import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, Users, HardHat, Briefcase, ChevronRight, ChevronDown } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { getApiRequest } from "@/lib/factoryApi";
import { useAppMode } from "@/contexts/AppModeContext";
import { useCompany } from "@/contexts/CompanyContext";
import { ConfirmationDialog } from "@/components/ConfirmationDialog";
import type { Employee } from "@shared/schema";

interface WorkerGroupWithMembers {
  id: number;
  name: string;
  description?: string;
  members: Employee[];
}

export function GroupsTab() {
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const { selectedCompany } = useCompany();
  const { toast } = useToast();

  const [workerGroupsExpanded, setWorkerGroupsExpanded] = useState<Record<number, boolean>>({});
  const [newWorkerGroupName, setNewWorkerGroupName] = useState("");
  const [newWorkerGroupDescription, setNewWorkerGroupDescription] = useState("");
  const [createWorkerGroupDialogOpen, setCreateWorkerGroupDialogOpen] = useState(false);
  const [selectedWorkerGroupForMembers, setSelectedWorkerGroupForMembers] = useState<WorkerGroupWithMembers | null>(
    null
  );
  const [workerGroupMembersDialogOpen, setWorkerGroupMembersDialogOpen] = useState(false);

  const { data: workerGroups = [] } = useQuery<WorkerGroupWithMembers[]>({
    queryKey: ["/api/worker-groups/with-members", selectedCompany?.id],
    enabled: !!selectedCompany,
  });

  const { data: allStaff = [] } = useQuery<Employee[]>({
    queryKey: ["/api/payroll/employees-with-balances", selectedCompany?.id],
    enabled: !!selectedCompany,
  });

  const workers = allStaff.filter((e) => e.employeeType === "Worker");
  const employees = allStaff.filter((e) => e.employeeType !== "Worker");

  const createWorkerGroupMutation = useMutation({
    mutationFn: async () => {
      const res = await modeApiRequest("POST", "/api/worker-groups", {
        name: newWorkerGroupName,
        description: newWorkerGroupDescription,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Group created successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/worker-groups/with-members", selectedCompany?.id] });
      setNewWorkerGroupName("");
      setNewWorkerGroupDescription("");
      setCreateWorkerGroupDialogOpen(false);
    },
    onError: (error: ClientErrorLike) => {
      toast({ title: "Error", description: error.message || "Failed to create group", variant: "destructive" });
    },
  });

  const deleteWorkerGroupMutation = useMutation({
    mutationFn: async (groupId: number) => {
      await modeApiRequest("DELETE", `/api/worker-groups/${groupId}`);
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Group deleted successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/worker-groups/with-members", selectedCompany?.id] });
    },
    onError: (error: ClientErrorLike) => {
      toast({ title: "Error", description: error.message || "Failed to delete group", variant: "destructive" });
    },
  });

  const addMemberMutation = useMutation({
    mutationFn: async ({ groupId, memberId }: { groupId: number; memberId: number }) => {
      await modeApiRequest("POST", `/api/worker-groups/${groupId}/members/${memberId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/worker-groups/with-members", selectedCompany?.id] });
      toast({ title: "Success", description: "Member added to group" });
    },
    onError: (error: ClientErrorLike) => {
      toast({ title: "Error", description: error.message || "Failed to add member to group", variant: "destructive" });
    },
  });

  const removeMemberMutation = useMutation({
    mutationFn: async ({ groupId, memberId }: { groupId: number; memberId: number }) => {
      await modeApiRequest("DELETE", `/api/worker-groups/${groupId}/members/${memberId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/worker-groups/with-members", selectedCompany?.id] });
      toast({ title: "Success", description: "Member removed from group" });
    },
    onError: (error: ClientErrorLike) => {
      toast({
        title: "Error",
        description: error.message || "Failed to remove member from group",
        variant: "destructive",
      });
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Groups</h2>
          <p className="text-muted-foreground">Manage groups for workers and employees to split payroll expenses</p>
        </div>
        <Button onClick={() => setCreateWorkerGroupDialogOpen(true)} data-testid="button-create-worker-group">
          <Plus className="mr-2 h-4 w-4" />
          Create Group
        </Button>
      </div>

      <div className="grid gap-4">
        {workerGroups.map((group) => {
          const isExpanded = !!workerGroupsExpanded[group.id];
          const workerMembers = group.members.filter((m) => m.employeeType === "Worker");
          const employeeMembers = group.members.filter((m) => m.employeeType !== "Worker");
          return (
            <Card key={group.id} className="overflow-hidden">
              <CardHeader className="py-4 px-6 flex flex-row items-center justify-between space-y-0 bg-muted/30">
                <div
                  className="flex items-center gap-3 cursor-pointer"
                  onClick={() => setWorkerGroupsExpanded((prev) => ({ ...prev, [group.id]: !isExpanded }))}
                >
                  {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  <Users className="h-5 w-5 text-primary" />
                  <div>
                    <CardTitle className="text-lg">{group.name}</CardTitle>
                    {group.description && <CardDescription>{group.description}</CardDescription>}
                  </div>
                  <div className="ml-2 flex items-center gap-1.5">
                    {workerMembers.length > 0 && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-sm text-xs font-medium bg-primary/10 text-primary">
                        <HardHat className="h-3 w-3 mr-1" />
                        {workerMembers.length} workers
                      </span>
                    )}
                    {employeeMembers.length > 0 && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-sm text-xs font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400">
                        <Briefcase className="h-3 w-3 mr-1" />
                        {employeeMembers.length} employees
                      </span>
                    )}
                    {group.members.length === 0 && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-sm text-xs font-medium bg-muted text-muted-foreground">
                        0 members
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setSelectedWorkerGroupForMembers(group);
                      setWorkerGroupMembersDialogOpen(true);
                    }}
                    data-testid={`button-manage-members-${group.id}`}
                  >
                    Manage Members
                  </Button>
                  <ConfirmationDialog
                    trigger={
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:text-destructive hover:bg-destructive/10"
                        data-testid={`button-delete-group-${group.id}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    }
                    title="Delete Group"
                    description={`Are you sure you want to delete the group "${group.name}"? Members will not be deleted but will become ungrouped.`}
                    confirmText="Delete"
                    variant="destructive"
                    onConfirm={() => deleteWorkerGroupMutation.mutate(group.id)}
                  />
                </div>
              </CardHeader>
              {isExpanded && (
                <CardContent className="p-0 border-t">
                  {group.members.length === 0 ? (
                    <div className="p-8 text-center text-muted-foreground italic">
                      No members assigned to this group yet.
                    </div>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-[100px]">Code</TableHead>
                          <TableHead>Name</TableHead>
                          <TableHead>Type</TableHead>
                          <TableHead>Department</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {group.members.map((member) => {
                          const isWorker = member.employeeType === "Worker";
                          return (
                            <TableRow key={member.id}>
                              <TableCell className="font-medium">{member.code}</TableCell>
                              <TableCell>
                                <div className="flex items-center gap-2">
                                  {isWorker ? (
                                    <HardHat className="h-4 w-4 text-muted-foreground" />
                                  ) : (
                                    <Briefcase className="h-4 w-4 text-blue-500" />
                                  )}
                                  {[member.firstName, member.lastName].filter(Boolean).join(" ")}
                                </div>
                              </TableCell>
                              <TableCell>
                                <Badge variant="outline" className="text-xs no-default-active-elevate">
                                  {member.employeeType || "Employee"}
                                </Badge>
                              </TableCell>
                              <TableCell>{member.department || "—"}</TableCell>
                              <TableCell className="text-right">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="text-muted-foreground hover:text-destructive"
                                  onClick={() =>
                                    removeMemberMutation.mutate({ groupId: group.id, memberId: member.id })
                                  }
                                  data-testid={`button-remove-member-${member.id}`}
                                >
                                  Remove
                                </Button>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              )}
            </Card>
          );
        })}

        {workerGroups.length === 0 && (
          <Card className="border-dashed border-2">
            <CardContent className="py-12 flex flex-col items-center justify-center text-center">
              <Users className="h-12 w-12 text-muted-foreground/50 mb-4" />
              <h3 className="text-lg font-semibold">No groups found</h3>
              <p className="text-muted-foreground mb-6">Create groups to split payroll expenses by team.</p>
              <Button variant="outline" onClick={() => setCreateWorkerGroupDialogOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                Create First Group
              </Button>
            </CardContent>
          </Card>
        )}
      </div>

      <Dialog open={createWorkerGroupDialogOpen} onOpenChange={setCreateWorkerGroupDialogOpen}>
        <DialogContent data-testid="dialog-create-worker-group">
          <DialogHeader>
            <DialogTitle>Create Group</DialogTitle>
            <DialogDescription>Define a new group for workers and/or employees.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="group-name">Group Name</Label>
              <Input
                id="group-name"
                value={newWorkerGroupName}
                onChange={(e) => setNewWorkerGroupName(e.target.value)}
                placeholder="e.g. Lubumbashi Workers"
                data-testid="input-group-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="group-desc">Description (Optional)</Label>
              <Input
                id="group-desc"
                value={newWorkerGroupDescription}
                onChange={(e) => setNewWorkerGroupDescription(e.target.value)}
                placeholder="Briefly describe the group's role"
                data-testid="input-group-desc"
              />
            </div>
          </div>
          <div className="flex justify-end gap-3 mt-4">
            <Button
              variant="outline"
              onClick={() => setCreateWorkerGroupDialogOpen(false)}
              data-testid="button-cancel-group"
            >
              Cancel
            </Button>
            <Button
              onClick={() => createWorkerGroupMutation.mutate()}
              disabled={!newWorkerGroupName || createWorkerGroupMutation.isPending}
              data-testid="button-submit-group"
            >
              Create Group
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={workerGroupMembersDialogOpen} onOpenChange={setWorkerGroupMembersDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Manage Group Members: {selectedWorkerGroupForMembers?.name}</DialogTitle>
            <DialogDescription>
              Add workers and employees to this group. Their payroll expenses will be split under this group's accounts.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {workers.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-2 px-1">
                  <HardHat className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Workers</span>
                </div>
                <div className="max-h-48 overflow-auto border rounded-md">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-12">In Group</TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead>Department</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {workers.map((worker: Employee) => {
                        const liveGroup = workerGroups.find((g) => g.id === selectedWorkerGroupForMembers?.id);
                        const isMember = liveGroup?.members.some((m) => m.id === worker.id);
                        return (
                          <TableRow key={worker.id}>
                            <TableCell>
                              <Checkbox
                                checked={isMember}
                                onCheckedChange={(checked) => {
                                  if (!selectedWorkerGroupForMembers) return;
                                  if (checked) {
                                    addMemberMutation.mutate({
                                      groupId: selectedWorkerGroupForMembers.id,
                                      memberId: worker.id,
                                    });
                                  } else {
                                    removeMemberMutation.mutate({
                                      groupId: selectedWorkerGroupForMembers.id,
                                      memberId: worker.id,
                                    });
                                  }
                                }}
                                data-testid={`checkbox-member-${worker.id}`}
                              />
                            </TableCell>
                            <TableCell>{[worker.firstName, worker.lastName].filter(Boolean).join(" ")}</TableCell>
                            <TableCell>{worker.department || "—"}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}

            {employees.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-2 px-1">
                  <Briefcase className="h-4 w-4 text-blue-500" />
                  <span className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Employees</span>
                </div>
                <div className="max-h-48 overflow-auto border rounded-md">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-12">In Group</TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead>Department</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {employees.map((emp: Employee) => {
                        const liveGroup = workerGroups.find((g) => g.id === selectedWorkerGroupForMembers?.id);
                        const isMember = liveGroup?.members.some((m) => m.id === emp.id);
                        return (
                          <TableRow key={emp.id}>
                            <TableCell>
                              <Checkbox
                                checked={isMember}
                                onCheckedChange={(checked) => {
                                  if (!selectedWorkerGroupForMembers) return;
                                  if (checked) {
                                    addMemberMutation.mutate({
                                      groupId: selectedWorkerGroupForMembers.id,
                                      memberId: emp.id,
                                    });
                                  } else {
                                    removeMemberMutation.mutate({
                                      groupId: selectedWorkerGroupForMembers.id,
                                      memberId: emp.id,
                                    });
                                  }
                                }}
                                data-testid={`checkbox-member-${emp.id}`}
                              />
                            </TableCell>
                            <TableCell>{[emp.firstName, emp.lastName].filter(Boolean).join(" ")}</TableCell>
                            <TableCell>{emp.department || "—"}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}

            <div className="flex justify-end">
              <Button onClick={() => setWorkerGroupMembersDialogOpen(false)} data-testid="button-close-members">
                Done
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
