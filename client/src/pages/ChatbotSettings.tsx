import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { EmptyState, ErrorState } from "@/components/ui/page-state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader } from "@/components/PageHeader";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Bot, Users, MessageCircle, Loader2, Check, Settings, History } from "lucide-react";
import { useChatbotSettingsState } from "./useChatbotSettingsState";
import {
  ChatbotSettingsTabsContentSection,
  ChatbotSettingsTabsContentSection2,
} from "./ChatbotSettingsTabsContentSection";
import { ChatbotSettingsCard } from "./ChatbotSettingsCard";

export default function ChatbotSettings() {
  const {
    patchHistoryError,
    refetchPatchHistory,
    usersError,
    refetchUsers,
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
        <ChatbotSettingsCard
          githubLoading={githubLoading}
          githubMutation={githubMutation}
          githubRepoUrl={githubRepoUrl}
          githubSettings={githubSettings}
          githubToken={githubToken}
          setGithubRepoUrl={setGithubRepoUrl}
          setGithubToken={setGithubToken}
          setShowToken={setShowToken}
          showToken={showToken}
        />
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
              ) : usersError && users.length === 0 ? (
                <ErrorState onAction={() => void refetchUsers()} actionLabel="Try again" className="py-8" />
              ) : users.length === 0 ? (
                <EmptyState title="No users found." className="py-8" />
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
          patchHistoryError={patchHistoryError}
          refetchPatchHistory={refetchPatchHistory}
          patchHistoryLoading={patchHistoryLoading}
          revertMutation={revertMutation}
        />
      </Tabs>
    </div>
  );
}
