// Extracted from ./ChatbotSettings.tsx to keep that module under the source-size cap.
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TabsContent } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Bot,
  Check,
  FileCode,
  GitCommit,
  History,
  Loader2,
  MessageCircle,
  RotateCcw,
  Trash2,
  Users,
} from "lucide-react";
import { format } from "date-fns";
import { useChatbotSettingsState, type MySession } from "./useChatbotSettingsState";
import { EmptyState, ErrorState } from "@/components/ui/page-state";

export function ChatbotSettingsTabsContentSection({
  allHistoryLoading,
  allSessions,
  chatStatus,
  deleteSessionMutation,
  mySessions,
  mySessionsLoading,
  selectedSession,
  selectedSessionMessages,
  sessionMessagesLoading,
  setSelectedSession,
  setViewAllChats,
  viewAllChats,
}: Pick<
  ReturnType<typeof useChatbotSettingsState>,
  | "allHistoryLoading"
  | "allSessions"
  | "chatStatus"
  | "deleteSessionMutation"
  | "mySessions"
  | "mySessionsLoading"
  | "selectedSession"
  | "selectedSessionMessages"
  | "sessionMessagesLoading"
  | "setSelectedSession"
  | "setViewAllChats"
  | "viewAllChats"
>) {
  return (
    <TabsContent value="history" className="space-y-4">
      {/* Admin toggle between My Chats / All Chats */}
      {chatStatus?.isAdminOrOwner && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={!viewAllChats ? "default" : "outline"}
            onClick={() => {
              setViewAllChats(false);
              setSelectedSession(null);
            }}
            data-testid="button-my-chats"
          >
            My Chats
          </Button>
          <Button
            size="sm"
            variant={viewAllChats ? "default" : "outline"}
            onClick={() => {
              setViewAllChats(true);
              setSelectedSession(null);
            }}
            data-testid="button-all-chats"
          >
            <Users className="h-3.5 w-3.5 mr-1.5" />
            All Users
          </Button>
        </div>
      )}

      <div className="grid md:grid-cols-3 gap-4">
        {/* Session list */}
        <Card className="md:col-span-1">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center justify-between gap-2">
              <span>{viewAllChats ? "All Conversations" : "My Conversations"}</span>
              {!viewAllChats && (
                <Badge variant="secondary" className="text-xs">
                  {mySessions.length}
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {(viewAllChats ? allHistoryLoading : mySessionsLoading) ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (viewAllChats ? allSessions : mySessions).length === 0 ? (
              <EmptyState
                icon={MessageCircle}
                title="No conversations yet."
                description="Start a chat to see history here."
                className="py-10"
              />
            ) : (
              <ScrollArea className="h-[440px]">
                <div className="space-y-0.5 p-2">
                  {(viewAllChats ? allSessions : mySessions).map((session) => {
                    const sid = session.sessionId ?? "";
                    const preview = viewAllChats
                      ? (session as (typeof allSessions)[0]).username
                      : (session as MySession).preview;
                    const msgCount = viewAllChats
                      ? (session as (typeof allSessions)[0]).messages.length
                      : (session as MySession).messageCount;
                    const lastTime = session.lastMessageTime;
                    return (
                      <div
                        key={sid}
                        className={`group flex items-start gap-1 w-full rounded-md transition-colors ${
                          selectedSession === sid ? "bg-primary/10" : "hover-elevate"
                        }`}
                      >
                        <button
                          onClick={() => setSelectedSession(sid)}
                          className="flex-1 min-w-0 text-left p-3"
                          data-testid={`button-session-${sid}`}
                        >
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium truncate flex-1">{preview}</p>
                            <Badge variant="outline" className="text-xs shrink-0">
                              {msgCount}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {format(new Date(lastTime), "MMM d, h:mm a")}
                          </p>
                        </button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 mt-1.5 mr-1 opacity-0 group-hover:opacity-100 touch:opacity-100 transition-opacity shrink-0 text-destructive"
                          onClick={() => deleteSessionMutation.mutate(sid)}
                          disabled={deleteSessionMutation.isPending}
                          title="Delete conversation"
                          data-testid={`button-delete-session-${sid}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>

        {/* Message view */}
        <Card className="md:col-span-2">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-base">Messages</CardTitle>
              {selectedSession && (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-destructive border-destructive/40 hover:bg-destructive/10"
                  onClick={() => deleteSessionMutation.mutate(selectedSession)}
                  disabled={deleteSessionMutation.isPending}
                  data-testid="button-delete-selected-session"
                >
                  {deleteSessionMutation.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  Delete
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {!selectedSession ? (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                <MessageCircle className="h-10 w-10 mb-3 opacity-40" />
                <p className="text-sm">Select a conversation to read it</p>
              </div>
            ) : sessionMessagesLoading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <ScrollArea className="h-[440px] p-4">
                <div className="space-y-3">
                  {selectedSessionMessages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`flex gap-2 ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                      data-testid={`message-${msg.id}`}
                    >
                      {msg.role === "assistant" && (
                        <div className="shrink-0 h-7 w-7 rounded-full bg-primary flex items-center justify-center">
                          <Bot className="h-4 w-4 text-primary-foreground" />
                        </div>
                      )}
                      <div
                        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                          msg.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted"
                        }`}
                      >
                        <p className="whitespace-pre-wrap wrap-break-word">{msg.message}</p>
                        <p className="text-xs opacity-60 mt-1">{format(new Date(msg.createdAt), "h:mm a")}</p>
                      </div>
                      {msg.role === "user" && (
                        <div className="shrink-0 h-7 w-7 rounded-full bg-muted flex items-center justify-center">
                          <span className="text-xs font-medium">Me</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </div>
    </TabsContent>
  );
}

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
