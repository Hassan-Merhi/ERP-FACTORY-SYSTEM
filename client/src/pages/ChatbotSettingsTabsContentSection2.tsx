// Extracted from ./ChatbotSettingsTabsContentSection.tsx
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TabsContent } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Check, FileCode, GitCommit, History, Loader2, RotateCcw } from "lucide-react";
import { format } from "date-fns";
import { useChatbotSettingsState } from "./useChatbotSettingsState";
import { EmptyState, ErrorState } from "@/components/ui/page-state";

export function ChatbotSettingsTabsContentSection2({
  patchHistory,
  patchHistoryError,
  patchHistoryLoading,
  refetchPatchHistory,
  revertMutation,
}: Pick<
  ReturnType<typeof useChatbotSettingsState>,
  "patchHistory" | "patchHistoryError" | "patchHistoryLoading" | "refetchPatchHistory" | "revertMutation"
>) {
  return (
    <TabsContent value="patches" className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <History className="h-5 w-5" />
            Applied Code Patches
          </CardTitle>
          <CardDescription>
            Every file change applied by the AI coding agent. Use Revert to restore a file to its previous content.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {patchHistoryLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : patchHistoryError && patchHistory.length === 0 ? (
            <ErrorState onAction={() => void refetchPatchHistory()} actionLabel="Try again" className="py-12" />
          ) : patchHistory.length === 0 ? (
            <EmptyState
              icon={FileCode}
              title="No patches applied yet."
              description="Applied AI code changes will appear here."
              className="py-12"
            />
          ) : (
            <div className="table-responsive">
              <Table mobileLayout="cards">
                <TableHeader>
                  <TableRow>
                    <TableHead>File</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Applied</TableHead>
                    <TableHead>Commit</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {patchHistory.map((entry) => (
                    <TableRow key={entry.id} data-testid={`row-patch-${entry.id}`}>
                      <TableCell className="font-mono text-xs max-w-[180px] truncate" title={entry.filePath}>
                        <div className="flex items-center gap-1.5">
                          <FileCode className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          <span className="truncate">{entry.filePath.replace(/^.*\//, "")}</span>
                        </div>
                        <span className="text-[11px] text-muted-foreground block truncate">{entry.filePath}</span>
                      </TableCell>
                      <TableCell className="text-xs max-w-[200px]">
                        <span className="text-muted-foreground truncate block">{entry.description || "—"}</span>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {format(new Date(entry.appliedAt), "MMM d, h:mm a")}
                      </TableCell>
                      <TableCell className="text-xs">
                        {entry.commitHash ? (
                          <div className="flex items-center gap-1 text-muted-foreground">
                            <GitCommit className="h-3 w-3 shrink-0" />
                            <span className="font-mono">{entry.commitHash.slice(0, 7)}</span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground/50">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {entry.revertedAt ? (
                          <Badge variant="secondary" className="text-xs">
                            <RotateCcw className="h-3 w-3 mr-1" />
                            Reverted
                          </Badge>
                        ) : (
                          <Badge
                            variant="outline"
                            className="text-xs bg-green-500/10 text-green-600 border-green-500/30"
                          >
                            <Check className="h-3 w-3 mr-1" />
                            Applied
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {!entry.revertedAt && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => revertMutation.mutate(entry.id)}
                            disabled={revertMutation.isPending}
                            data-testid={`button-revert-${entry.id}`}
                          >
                            {revertMutation.isPending ? (
                              <Loader2 className="h-3 w-3 animate-spin mr-1" />
                            ) : (
                              <RotateCcw className="h-3 w-3 mr-1" />
                            )}
                            Revert
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </TabsContent>
  );
}
