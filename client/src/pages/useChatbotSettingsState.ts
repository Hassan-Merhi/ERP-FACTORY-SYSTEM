// Extracted from ./ChatbotSettings.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";

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

export interface MySession {
  sessionId: string;
  messageCount: number;
  preview: string;
  lastMessageTime: string;
}

export function useChatbotSettingsState() {
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
      toast({
        title: "Save failed",
        description: error.message || "Failed to save GitHub settings",
        variant: "destructive",
      });
    },
  });
  const {
    data: users = [],
    isLoading: usersLoading,
    isError: usersError,
    refetch: refetchUsers,
  } = useQuery<UserChatbotStatus[]>({
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

  const { data: mySessions = [], isLoading: mySessionsLoading } = useQuery<MySession[]>({
    queryKey: ["/api/chatbot/my-sessions"],
    enabled: activeTab === "history",
  });

  const {
    data: patchHistory = [],
    isLoading: patchHistoryLoading,
    isError: patchHistoryError,
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
        title: "Update failed",
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
        title: "Update failed",
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
      toast({
        title: "Delete failed",
        description: error.message || "Failed to delete conversation",
        variant: "destructive",
      });
    },
  });
  return {
    refetchPatchHistory,
    patchHistoryError,
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
  };
}
