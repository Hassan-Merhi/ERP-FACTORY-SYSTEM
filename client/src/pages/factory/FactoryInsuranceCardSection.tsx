// Extracted from ./FactoryInsurance.tsx to keep that module under the source-size cap.
import { Edit, Loader2, Shield, ToggleLeft, ToggleRight, Trash2 } from "lucide-react";
import { queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useFactoryInsuranceState } from "./useFactoryInsuranceState";

export function FactoryInsuranceCardSection({
  filteredMembers,
  formatDisplayDate,
  isError,
  isLoading,
  members,
  membersError,
  recordChanges,
  setDeleteMember,
  setEditMember,
  setStatementMember,
  toggleMutation,
}: Pick<
  ReturnType<typeof useFactoryInsuranceState>,
  | "filteredMembers"
  | "formatDisplayDate"
  | "isError"
  | "isLoading"
  | "members"
  | "membersError"
  | "recordChanges"
  | "setDeleteMember"
  | "setEditMember"
  | "setStatementMember"
  | "toggleMutation"
>) {
  return (
    <Card className="overflow-hidden rounded-2xl border-slate-200 bg-white shadow-sm dark:border-slate-700/70 dark:bg-[hsl(var(--factory-hue)_58%_10%)] dark:shadow-lg dark:shadow-blue-950/20">
      <CardContent className="overflow-x-auto p-0">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : isError ? (
          <div className="flex flex-col items-center justify-center py-12 text-destructive gap-2">
            <Shield className="h-10 w-10 mb-2 opacity-30" />
            <p className="text-sm font-medium">Failed to load insurance members</p>
            <p className="text-xs text-muted-foreground max-w-xs text-center">
              {(membersError as Error)?.message || "Unknown error"}
            </p>
            <Button
              size="sm"
              variant="outline"
              className="mt-1"
              onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/insurance/members"] })}
            >
              Retry
            </Button>
          </div>
        ) : filteredMembers.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <Shield className="h-10 w-10 mb-2 opacity-30" />
            <p className="text-sm">
              {members.length === 0
                ? "No insurance members yet. Add one to get started."
                : "No members match your search."}
            </p>
          </div>
        ) : (
          <Table className="min-w-[1140px]">
            <TableHeader className="bg-slate-100/90 dark:bg-[hsl(var(--factory-hue)_45%_20%)]">
              <TableRow className="border-slate-200 hover:bg-transparent dark:border-slate-700/70 dark:hover:bg-transparent">
                <TableHead className="h-12 whitespace-nowrap text-[11px] font-bold uppercase tracking-wide text-slate-600 dark:text-slate-200">
                  Name
                </TableHead>
                <TableHead className="h-12 whitespace-nowrap text-[11px] font-bold uppercase tracking-wide text-slate-600 dark:text-slate-200">
                  Insurance No.
                </TableHead>
                <TableHead className="h-12 whitespace-nowrap text-[11px] font-bold uppercase tracking-wide text-slate-600 dark:text-slate-200">
                  Nationality
                </TableHead>
                <TableHead className="h-12 whitespace-nowrap text-[11px] font-bold uppercase tracking-wide text-slate-600 dark:text-slate-200">
                  Position
                </TableHead>
                <TableHead className="h-12 whitespace-nowrap text-[11px] font-bold uppercase tracking-wide text-slate-600 dark:text-slate-200">
                  Start Date
                </TableHead>
                <TableHead className="h-12 whitespace-nowrap text-[11px] font-bold uppercase tracking-wide text-slate-600 dark:text-slate-200">
                  Date of Birth
                </TableHead>
                <TableHead className="h-12 whitespace-nowrap text-right text-[11px] font-bold uppercase tracking-wide text-slate-600 dark:text-slate-200">
                  Monthly Amount
                </TableHead>
                <TableHead className="h-12 whitespace-nowrap text-[11px] font-bold uppercase tracking-wide text-slate-600 dark:text-slate-200">
                  Status
                </TableHead>
                <TableHead className="h-12 whitespace-nowrap text-right text-[11px] font-bold uppercase tracking-wide text-slate-600 dark:text-slate-200">
                  Actions
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredMembers.map((m) => (
                <TableRow
                  key={m.id}
                  className="cursor-pointer border-slate-100 transition-colors even:bg-slate-50/80 hover:bg-blue-50/80 dark:border-slate-700/60 dark:even:bg-[hsl(var(--factory-hue)_45%_16%)]/55 dark:hover:bg-blue-900/25"
                  onClick={() => setStatementMember(m)}
                  data-testid={`row-member-${m.id}`}
                >
                  <TableCell className="whitespace-nowrap font-semibold text-slate-900 dark:text-slate-100">
                    {m.name}
                  </TableCell>
                  <TableCell className="font-mono text-sm text-slate-700 dark:text-slate-200">
                    {m.insuranceNumber || "—"}
                  </TableCell>
                  <TableCell>
                    <span
                      className={
                        m.nationality
                          ? `inline-flex rounded-lg px-2.5 py-1 text-xs font-semibold ${m.nationality.toLowerCase() === "lebanese" ? "bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-200" : "bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-200"}`
                          : "text-muted-foreground"
                      }
                    >
                      {m.nationality || "—"}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{m.positionWorking || "—"}</TableCell>
                  <TableCell>{formatDisplayDate(m.startDate)}</TableCell>
                  <TableCell>{m.dob ? formatDisplayDate(m.dob) : "—"}</TableCell>
                  <TableCell className="text-right font-mono font-semibold text-slate-900 dark:text-slate-100">
                    ${parseFloat(m.amount).toFixed(2)}
                  </TableCell>
                  <TableCell>
                    {m.active ? (
                      <Badge
                        variant="secondary"
                        className="gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-emerald-700 dark:border-emerald-500/25 dark:bg-emerald-500/15 dark:text-emerald-300"
                        data-testid={`badge-status-${m.id}`}
                      >
                        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Active
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className="rounded-full text-muted-foreground"
                        data-testid={`badge-status-${m.id}`}
                      >
                        Inactive
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {recordChanges.allowed && (
                      <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 rounded-lg border border-slate-200 bg-slate-50/70 hover:bg-blue-100 dark:border-slate-600/70 dark:bg-slate-800/60 dark:hover:bg-slate-700"
                          onClick={() => setEditMember(m)}
                          title="Edit member"
                          data-testid={`button-edit-${m.id}`}
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 rounded-lg border border-slate-200 bg-slate-50/70 hover:bg-blue-100 dark:border-slate-600/70 dark:bg-slate-800/60 dark:hover:bg-slate-700"
                          onClick={() => toggleMutation.mutate(m)}
                          title={m.active ? "Deactivate" : "Activate"}
                          data-testid={`button-toggle-${m.id}`}
                        >
                          {m.active ? (
                            <ToggleRight className="h-4 w-4 text-green-600" />
                          ) : (
                            <ToggleLeft className="h-4 w-4 text-muted-foreground" />
                          )}
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 rounded-lg border border-slate-200 bg-slate-50/70 hover:bg-blue-100 dark:border-slate-600/70 dark:bg-slate-800/60 dark:hover:bg-slate-700"
                          onClick={() => setDeleteMember(m)}
                          title="Delete member"
                          data-testid={`button-delete-${m.id}`}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
