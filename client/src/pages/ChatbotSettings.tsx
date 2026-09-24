import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader } from "@/components/PageHeader";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  Bot,
  Users,
  MessageCircle,
  Loader2,
  Check,
  Settings,
  GitBranch,
  Eye,
  EyeOff,
  History,
  FileCode,
  RotateCcw,
  GitCommit,
  Trash2,
} from "lucide-react";
import { format } from "date-fns";

interface UserChatbotStatus {
  id: string;
  username: string;
  chatbotEnabled: boolean;
  active: boolean;
}

interface ChatMessage {
  id: number;
  userId: number;
  sessionId: string;
  role: "user" | "assistant";
  message: string;
  createdAt: string;
  username?: string;
}

interface GitHubSettings {
  repoUrl: string;
  hasToken: boolean;
  configured: boolean;
}

interface PatchHistoryEntry {
  id: number;
  companyId: number;
  filePath: string;
  description: string | null;
  appliedByUserId: string | null;
  appliedAt: string;
  commitHash: string | null;
  revertedAt: string | null;
}

interface MySession {
  sessionId: string;
  messageCount: number;
  preview: string;
  lastMessageTime: string;
}

export default function ChatbotSettings() {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState("users");
  const [githubRepoUrl, setGithubRepoUrl] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [viewAllChats, setViewAllChats] = useState(false);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);

  const { data: githubSettings, isLoading: githubLoading } = useQuery<GitHubSettings>({
    queryKey: ["/api/chatbot/github-settings"],
  });

  const githubMutation = useMutation({
    mutationFn: async ({ repoUrl, token }: { repoUrl?: string; token?: string }) => {
      const response = await apiRequest("PATCH", "/api/chatbot/github-settings", {
        repoUrl: repoUrl || undefined,
        token: token || undefined,
      });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/chatbot/github-settings"] });
      setGithubRepoUrl("");
      setGithubToken("");
      toast({ title: "GitHub settings saved", description: "Repository settings have been updated." });
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message || "Failed to save GitHub settings", variant: "destructive" });
    },
  });

  const { data: users = [], isLoading: usersLoading } = useQuery<UserChatbotStatus[]>({
    queryKey: ["/api/users/chatbot-status"],
  });

  const { data: chatStatus } = useQuery<{
    enabled: boolean;
    hasApiKey: boolean;
    providerName: string;
    selectedProvider: string;
    isAdminOrOwner: boolean;
  }>({
    queryKey: ["/api/chatbot/status"],
  });

  const { data: chatHistory = [], isLoading: allHistoryLoading } = useQuery<ChatMessage[]>({
    queryKey: ["/api/chatbot/all-history"],
    enabled: activeTab === "history" && !!chatStatus?.isAdminOrOwner && viewAllChats,
  });

  const {
    data: mySessions = [],
    isLoading: mySessionsLoading,
    refetch: _refetchMySessions,
  } = useQuery<MySession[]>({
    queryKey: ["/api/chatbot/my-sessions"],
    enabled: activeTab === "history",
  });

  const {
    data: patchHistory = [],
    isLoading: patchHistoryLoading,
    refetch: refetchPatchHistory,
  } = useQuery<PatchHistoryEntry[]>({
    queryKey: ["/api/chatbot/patch-history"],
    enabled: activeTab === "patches" && !!chatStatus?.isAdminOrOwner,
  });

  const revertMutation = useMutation({
    mutationFn: async (id: number) => {
      const response = await apiRequest("POST", `/api/chatbot/revert-patch/${id}`, {});
      return response.json();
    },
    onSuccess: (data) => {
      refetchPatchHistory();
      toast({ title: "Reverted", description: `${data.filePath} has been restored to its previous content.` });
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Revert failed", description: error.message || "Could not revert patch", variant: "destructive" });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ userId, enabled }: { userId: string; enabled: boolean }) => {
      const response = await apiRequest("PATCH", `/api/users/${userId}/chatbot`, { enabled });
      return response.json();
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/users/chatbot-status"] });
      toast({
        title: variables.enabled ? "Chatbot enabled" : "Chatbot disabled",
        description: `User chatbot access has been ${variables.enabled ? "enabled" : "disabled"}.`,
      });
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({
        title: "Error",
        description: error.message || "Failed to update chatbot access",
        variant: "destructive",
      });
    },
  });

  const providerMutation = useMutation({
    mutationFn: async (provider: string) => {
      const response = await apiRequest("PATCH", "/api/chatbot/provider", { provider });
      return response.json();
    },
    onSuccess: (_, provider) => {
      queryClient.invalidateQueries({ queryKey: ["/api/chatbot/status"] });
      toast({
        title: "AI Provider Updated",
        description: `Switched to ${provider === "chatgpt" ? "ChatGPT (OpenAI)" : provider === "grok" ? "Grok (xAI)" : "Gemini (Google)"}.`,
      });
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({
        title: "Error",
        description: error.message || "Failed to update AI provider",
        variant: "destructive",
      });
    },
  });

  const groupedHistory = chatHistory.reduce(
    (acc, msg) => {
      const key = msg.sessionId;
      if (!acc[key]) {
        acc[key] = {
          sessionId: key,
          username: msg.username || "Unknown",
          userId: msg.userId,
          messages: [],
          lastMessageTime: msg.createdAt,
        };
      }
      acc[key].messages.push(msg);
      if (new Date(msg.createdAt) > new Date(acc[key].lastMessageTime)) {
        acc[key].lastMessageTime = msg.createdAt;
      }
      return acc;
    },
    {} as Record<
      string,
      { sessionId: string; username: string; userId: number; messages: ChatMessage[]; lastMessageTime: string }
    >
  );

  const allSessions = Object.values(groupedHistory).sort(
    (a, b) => new Date(b.lastMessageTime).getTime() - new Date(a.lastMessageTime).getTime()
  );

  const { data: selectedSessionMessages = [], isLoading: sessionMessagesLoading } = useQuery<
    { id: number; role: string; message: string; createdAt: string }[]
  >({
    queryKey: [`/api/chatbot/history/${selectedSession}`],
    enabled: !!selectedSession,
  });

  const deleteSessionMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      const response = await apiRequest("DELETE", `/api/chatbot/session/${sessionId}`, {});
      return response.json();
    },
    onSuccess: (_, sessionId) => {
      queryClient.invalidateQueries({ queryKey: ["/api/chatbot/my-sessions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/chatbot/all-history"] });
      if (selectedSession === sessionId) setSelectedSession(null);
      toast({ title: "Deleted", description: "The conversation has been deleted." });
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message || "Failed to delete conversation", variant: "destructive" });
    },
  });

  return (
    <div className="container mx-auto space-y-6 px-0 py-0 sm:px-6 sm:py-6">
      <PageHeader
        title="AI Chatbot Settings"
        subtitle="Manage chatbot access and view conversations"
        icon={<Bot className="h-5 w-5 text-primary" />}
        backTarget="/settings"
      />

      {!chatStatus?.hasApiKey && (
        <Card className="border-orange-500/50 bg-orange-500/10">
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <Bot className="h-5 w-5 text-orange-500" />
              <p className="text-sm">
                <span className="font-medium">API Key Missing:</span> The {chatStatus?.providerName || "AI"} API key is
                not configured. Please add the{" "}
                {chatStatus?.selectedProvider === "chatgpt"
                  ? "OPENAI_API_KEY"
                  : chatStatus?.selectedProvider === "grok"
                    ? "XAI_API_KEY"
                    : "GEMINI_API_KEY"}{" "}
                secret in the Secrets tab to enable the AI chatbot.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {chatStatus?.isAdminOrOwner && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Settings className="h-5 w-5" />
              AI Provider
            </CardTitle>
            <CardDescription>Choose which AI service powers the chatbot</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-4">
              <Select
                value={chatStatus?.selectedProvider || "gemini"}
                onValueChange={(value) => providerMutation.mutate(value)}
                disabled={providerMutation.isPending}
              >
                <SelectTrigger className="w-[200px]" data-testid="select-ai-provider">
                  <SelectValue placeholder="Select AI Provider" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="gemini">Gemini (Google)</SelectItem>
                  <SelectItem value="chatgpt">ChatGPT (OpenAI)</SelectItem>
                  <SelectItem value="grok">Grok (xAI)</SelectItem>
                </SelectContent>
              </Select>
              {providerMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {chatStatus?.hasApiKey && (
                <Badge variant="outline" className="bg-green-500/10 text-green-600 border-green-500/30">
                  <Check className="h-3 w-3 mr-1" />
                  API Key Configured
                </Badge>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {chatStatus?.isAdminOrOwner && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              <GitBranch className="h-5 w-5" />
              GitHub Integration
            </CardTitle>
            <CardDescription>
              Store your repository URL and a GitHub token separately — the token is never returned to the browser and
              is composed server-side when pushing.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {githubLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading...
              </div>
            ) : (
              <>
                {githubSettings?.configured && (
                  <div className="flex items-center gap-2 text-sm flex-wrap">
                    <Check className="h-4 w-4 text-green-500 shrink-0" />
                    <span className="font-mono text-muted-foreground truncate max-w-sm">{githubSettings.repoUrl}</span>
                    <Badge
                      variant="outline"
                      className={
                        githubSettings.hasToken
                          ? "bg-green-500/10 text-green-600 border-green-500/30"
                          : "bg-orange-500/10 text-orange-600 border-orange-500/30"
                      }
                    >
                      {githubSettings.hasToken ? "Token configured" : "No token"}
                    </Badge>
                  </div>
                )}

                <div className="space-y-2">
                  <label className="text-xs font-medium text-muted-foreground">Repository URL</label>
                  <input
                    type="text"
                    className="w-full h-9 rounded-md border border-border bg-background px-3 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                    placeholder={
                      githubSettings?.configured ? "Enter new URL to replace…" : "https://github.com/user/repo.git"
                    }
                    value={githubRepoUrl}
                    onChange={(e) => setGithubRepoUrl(e.target.value)}
                    data-testid="input-github-repo-url"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-medium text-muted-foreground">
                    Personal Access Token
                    {githubSettings?.hasToken && (
                      <span className="ml-2 text-green-600">(currently set — enter new to replace)</span>
                    )}
                  </label>
                  <div className="relative">
                    <input
                      type={showToken ? "text" : "password"}
                      className="w-full h-9 rounded-md border border-border bg-background px-3 pr-9 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                      placeholder={githubSettings?.hasToken ? "Enter new token to replace…" : "ghp_xxxxxxxxxxxx"}
                      value={githubToken}
                      onChange={(e) => setGithubToken(e.target.value)}
                      data-testid="input-github-token"
                    />
                    <button
                      type="button"
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => setShowToken((v) => !v)}
                      tabIndex={-1}
                    >
                      {showToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </div>

                <Button
                  size="sm"
                  onClick={() =>
                    githubMutation.mutate({ repoUrl: githubRepoUrl || undefined, token: githubToken || undefined })
                  }
                  disabled={githubMutation.isPending || (!githubRepoUrl.trim() && !githubToken.trim())}
                  data-testid="button-save-github"
                >
                  {githubMutation.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                  ) : (
                    <Check className="h-3.5 w-3.5 mr-1" />
                  )}
                  Save Settings
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList>
          <TabsTrigger value="users" className="gap-2" data-testid="tab-users">
            <Users className="h-4 w-4" />
            User Access
          </TabsTrigger>
          <TabsTrigger value="history" className="gap-2" data-testid="tab-history">
            <MessageCircle className="h-4 w-4" />
            Chat History
          </TabsTrigger>
          <TabsTrigger value="patches" className="gap-2" data-testid="tab-patches">
            <History className="h-4 w-4" />
            Patch History
          </TabsTrigger>
        </TabsList>

        <TabsContent value="users" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5" />
                User Chatbot Access
              </CardTitle>
              <CardDescription>
                Enable or disable AI chatbot access for each user. Only users with access enabled can use the floating
                chat widget.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {usersLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : users.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">No users found.</p>
              ) : (
                <div className="table-responsive">
                  <Table mobileLayout="cards">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Username</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Chatbot Access</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {users.map((user) => (
                        <TableRow key={user.id} data-testid={`row-user-${user.id}`}>
                          <TableCell className="font-medium">{user.username}</TableCell>
                          <TableCell>
                            <Badge variant={user.active ? "default" : "secondary"}>
                              {user.active ? "Active" : "Inactive"}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            <Switch
                              checked={user.chatbotEnabled || false}
                              onCheckedChange={(checked) =>
                                toggleMutation.mutate({ userId: user.id, enabled: checked })
                              }
                              disabled={toggleMutation.isPending}
                              data-testid={`switch-chatbot-${user.id}`}
                            />
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
                  <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
                    <MessageCircle className="h-8 w-8 mb-2 opacity-40" />
                    <p className="text-sm">No conversations yet.</p>
                    <p className="text-xs mt-1 opacity-70">Start a chat to see history here.</p>
                  </div>
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
                              className="h-8 w-8 mt-1.5 mr-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 text-destructive"
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
                            <div className="flex-shrink-0 h-7 w-7 rounded-full bg-primary flex items-center justify-center">
                              <Bot className="h-4 w-4 text-primary-foreground" />
                            </div>
                          )}
                          <div
                            className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                              msg.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted"
                            }`}
                          >
                            <p className="whitespace-pre-wrap break-words">{msg.message}</p>
                            <p className="text-xs opacity-60 mt-1">{format(new Date(msg.createdAt), "h:mm a")}</p>
                          </div>
                          {msg.role === "user" && (
                            <div className="flex-shrink-0 h-7 w-7 rounded-full bg-muted flex items-center justify-center">
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
              ) : patchHistory.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                  <FileCode className="h-10 w-10 mb-3 opacity-40" />
                  <p className="text-sm">No patches applied yet.</p>
                  <p className="text-xs mt-1 opacity-70">Applied AI code changes will appear here.</p>
                </div>
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
                            <span className="text-[10px] text-muted-foreground block truncate">{entry.filePath}</span>
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
      </Tabs>
    </div>
  );
}
