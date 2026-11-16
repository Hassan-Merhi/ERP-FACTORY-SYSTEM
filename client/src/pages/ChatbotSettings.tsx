import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader } from "@/components/PageHeader";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Bot, Users, MessageCircle, Loader2, Check, Settings, GitBranch, Eye, EyeOff, History } from "lucide-react";
import { useChatbotSettingsState } from "./useChatbotSettingsState";
import {
  ChatbotSettingsTabsContentSection,
  ChatbotSettingsTabsContentSection2,
} from "./ChatbotSettingsTabsContentSection";

export default function ChatbotSettings() {
  const {
    activeTab,
    allHistoryLoading,
    allSessions,
    chatStatus,
    deleteSessionMutation,
    githubLoading,
    githubMutation,
    githubRepoUrl,
    githubSettings,
    githubToken,
    mySessions,
    mySessionsLoading,
    patchHistory,
    patchHistoryLoading,
    providerMutation,
    revertMutation,
    selectedSession,
    selectedSessionMessages,
    sessionMessagesLoading,
    setActiveTab,
    setGithubRepoUrl,
    setGithubToken,
    setSelectedSession,
    setShowToken,
    setViewAllChats,
    showToken,
    toggleMutation,
    users,
    usersLoading,
    viewAllChats,
  } = useChatbotSettingsState();

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
                    className="w-full h-9 rounded-md border border-border bg-background px-3 text-sm font-mono focus:outline-hidden focus:ring-1 focus:ring-ring"
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
                      className="w-full h-9 rounded-md border border-border bg-background px-3 pr-9 text-sm font-mono focus:outline-hidden focus:ring-1 focus:ring-ring"
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

        <ChatbotSettingsTabsContentSection
          allHistoryLoading={allHistoryLoading}
          allSessions={allSessions}
          chatStatus={chatStatus}
          deleteSessionMutation={deleteSessionMutation}
          mySessions={mySessions}
          mySessionsLoading={mySessionsLoading}
          selectedSession={selectedSession}
          selectedSessionMessages={selectedSessionMessages}
          sessionMessagesLoading={sessionMessagesLoading}
          setSelectedSession={setSelectedSession}
          setViewAllChats={setViewAllChats}
          viewAllChats={viewAllChats}
        />

        <ChatbotSettingsTabsContentSection2
          patchHistory={patchHistory}
          patchHistoryLoading={patchHistoryLoading}
          revertMutation={revertMutation}
        />
      </Tabs>
    </div>
  );
}
