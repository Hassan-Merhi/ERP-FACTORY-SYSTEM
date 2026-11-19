// Extracted from ./Chat.tsx to keep that module under the source-size cap.
import { searchAny } from "@shared/searchNormalization";
import type { ClientErrorLike } from "@/lib/clientError";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useToast } from "@/hooks/use-toast";
import { subscribeRealtimeChatEvents } from "@/hooks/use-ws-invalidation";
import type { DirectMessage } from "@shared/schema";
import type { ChatUser, PendingFile } from "./ChatTypes";

export function useChatState() {
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [messageText, setMessageText] = useState("");
  const [pendingFile, setPendingFile] = useState<PendingFile | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [typingUserId, setTypingUserId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingIndicatorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingActiveRef = useRef(false);
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const { toast } = useToast();
  const {
    data: chatUsers = [],
    isLoading: usersLoading,
    isError: usersError,
    refetch: refetchUsers,
  } = useQuery<ChatUser[]>({
    queryKey: ["/api/chat/users"],
  });

  const { data: messages = [], isLoading: messagesLoading } = useQuery<DirectMessage[]>({
    queryKey: ["/api/chat/conversations", selectedUserId],
    queryFn: async () => {
      if (!selectedUserId) return [];
      const res = await fetch(`/api/chat/conversations/${selectedUserId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    enabled: !!selectedUserId,
  });

  const isTyping = typingUserId === selectedUserId;

  const sendTypingSignal = useCallback(
    (typing: boolean) => {
      if (!selectedUserId) return;
      fetch("/api/chat/typing", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ receiverId: selectedUserId, isTyping: typing }),
      }).catch(() => {});
    },
    [selectedUserId]
  );

  const stopLocalTyping = useCallback(() => {
    if (!typingActiveRef.current) return;
    typingActiveRef.current = false;
    sendTypingSignal(false);
  }, [sendTypingSignal]);

  const handleTextChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setMessageText(e.target.value);
    if (!typingActiveRef.current) {
      typingActiveRef.current = true;
      sendTypingSignal(true);
    }
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(stopLocalTyping, 3000);
  };

  const sendMutation = useMutation({
    mutationFn: async (data: {
      receiverId: string;
      message?: string;
      fileUrl?: string;
      fileName?: string;
      fileType?: string;
      fileSize?: number;
    }) => {
      return await modeApiRequest("POST", "/api/chat/messages", data);
    },
    onSuccess: () => {
      // The direct WebSocket event normally patches the conversation first. A
      // focused invalidation remains as recovery if the socket was reconnecting.
      queryClient.invalidateQueries({ queryKey: ["/api/chat/conversations", selectedUserId] });
      queryClient.invalidateQueries({ queryKey: ["/api/chat/users"] });
      setMessageText("");
      setPendingFile(null);
      stopLocalTyping();
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      inputRef.current?.focus();
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({
        title: "Message failed to send",
        description: error?.message || "Please try again.",
        variant: "destructive",
      });
    },
  });

  const markReadMutation = useMutation({
    mutationFn: async (userId: string) => {
      return await modeApiRequest("POST", `/api/chat/mark-read/${userId}`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/chat/users"] });
      queryClient.invalidateQueries({ queryKey: ["/api/chat/unread-count"] });
    },
  });

  const clearMutation = useMutation({
    mutationFn: async (userId: string) => {
      const res = await fetch(`/api/chat/messages/${userId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to clear messages");
      return res.json();
    },
    onSuccess: () => {
      queryClient.setQueryData<DirectMessage[]>(["/api/chat/conversations", selectedUserId], []);
      queryClient.invalidateQueries({ queryKey: ["/api/chat/users"] });
      setClearConfirmOpen(false);
      toast({ title: "Conversation cleared" });
    },
    onError: () => {
      toast({ title: "Failed to clear messages", variant: "destructive" });
    },
  });

  useEffect(() => {
    return subscribeRealtimeChatEvents((event) => {
      if (event.type === "message:new") {
        const message = event.message;
        if (selectedUserId && (message.senderId === selectedUserId || message.receiverId === selectedUserId)) {
          queryClient.setQueryData<DirectMessage[]>(["/api/chat/conversations", selectedUserId], (current) => {
            if (!current || current.some((row) => row.id === message.id)) return current;
            return [...current, message];
          });
        }

        if (document.visibilityState === "visible") {
          void queryClient.invalidateQueries({ queryKey: ["/api/chat/users"], refetchType: "active" });
          void queryClient.invalidateQueries({ queryKey: ["/api/chat/unread-count"], refetchType: "active" });
        }
        return;
      }

      if (event.type === "typing:update") {
        if (event.senderId !== selectedUserId) return;
        if (typingIndicatorTimeoutRef.current) clearTimeout(typingIndicatorTimeoutRef.current);
        setTypingUserId(event.isTyping ? event.senderId : null);
        if (event.isTyping && event.until) {
          typingIndicatorTimeoutRef.current = setTimeout(
            () => setTypingUserId((current) => (current === event.senderId ? null : current)),
            Math.max(0, event.until - Date.now())
          );
        }
        return;
      }

      if (event.type === "conversation:cleared") {
        if (selectedUserId && event.userIds.includes(selectedUserId)) {
          queryClient.setQueryData<DirectMessage[]>(["/api/chat/conversations", selectedUserId], []);
        }
      }

      if (document.visibilityState === "visible") {
        void queryClient.invalidateQueries({ queryKey: ["/api/chat/users"], refetchType: "active" });
        void queryClient.invalidateQueries({ queryKey: ["/api/chat/unread-count"], refetchType: "active" });
        if (event.type === "message:read" && selectedUserId === event.readerId) {
          void queryClient.invalidateQueries({
            queryKey: ["/api/chat/conversations", selectedUserId],
            refetchType: "active",
          });
        }
      }
    });
  }, [selectedUserId]);

  useEffect(() => {
    if (selectedUserId) {
      markReadMutation.mutate(selectedUserId);
    }
  }, [selectedUserId, messages.length, markReadMutation]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping]);

  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      if (typingIndicatorTimeoutRef.current) clearTimeout(typingIndicatorTimeoutRef.current);
      if (typingActiveRef.current) {
        typingActiveRef.current = false;
        sendTypingSignal(false);
      }
    };
  }, [sendTypingSignal]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const isImage = file.type.startsWith("image/");
    const previewUrl = isImage ? URL.createObjectURL(file) : null;
    setPendingFile({ file, previewUrl });
    e.target.value = "";
  };

  const removePendingFile = () => {
    if (pendingFile?.previewUrl) URL.revokeObjectURL(pendingFile.previewUrl);
    setPendingFile(null);
  };

  const handleSend = async () => {
    if ((!messageText.trim() && !pendingFile) || !selectedUserId) return;

    if (pendingFile) {
      setIsUploading(true);
      try {
        const formData = new FormData();
        formData.append("file", pendingFile.file);
        const res = await fetch("/api/chat/upload", {
          method: "POST",
          credentials: "include",
          body: formData,
        });
        if (!res.ok) throw new Error("Upload failed");
        const uploaded = await res.json();
        sendMutation.mutate({
          receiverId: selectedUserId,
          message: messageText.trim() || undefined,
          fileUrl: uploaded.fileUrl,
          fileName: uploaded.fileName,
          fileType: uploaded.fileType,
          fileSize: uploaded.fileSize,
        });
      } catch {
        toast({ title: "File upload failed", variant: "destructive" });
      } finally {
        setIsUploading(false);
      }
    } else {
      sendMutation.mutate({ receiverId: selectedUserId, message: messageText.trim() });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSelectNewUser = (userId: string) => {
    setSelectedUserId(userId);
    setNewChatOpen(false);
    setSearchQuery("");
  };

  const getInitials = (username: string) => username.slice(0, 2).toUpperCase();

  const formatTime = (dateStr: string) => {
    const d = new Date(dateStr);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return (
      d.toLocaleDateString([], { month: "short", day: "numeric" }) +
      " " +
      d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    );
  };

  const formatLastSeen = (user: ChatUser): string => {
    if (user.isOnline) return "Online";
    if (!user.lastSeen) return "Offline";
    const d = new Date(user.lastSeen);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return "Last seen just now";
    if (diffMins < 60) return `Last seen ${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24 && d.toDateString() === now.toDateString())
      return `Last seen today at ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    if (diffHours < 48)
      return `Last seen yesterday at ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    return `Last seen ${d.toLocaleDateString([], { month: "short", day: "numeric" })}`;
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const selectedUser = chatUsers.find((u) => u.id === selectedUserId);
  const conversationUsers = chatUsers.filter((u) => u.hasMessages || u.unreadCount > 0 || u.id === selectedUserId);
  const filteredAllUsers = chatUsers.filter((u) => searchAny(searchQuery, u.username));

  const isSending = sendMutation.isPending || isUploading;
  return {
    chatUsers,
    usersError,
    refetchUsers,
    clearConfirmOpen,
    clearMutation,
    conversationUsers,
    fileInputRef,
    filteredAllUsers,
    formatFileSize,
    formatLastSeen,
    formatTime,
    getInitials,
    handleFileSelect,
    handleKeyDown,
    handleSelectNewUser,
    handleSend,
    handleTextChange,
    inputRef,
    isSending,
    isTyping,
    messageText,
    messages,
    messagesEndRef,
    messagesLoading,
    newChatOpen,
    pendingFile,
    removePendingFile,
    searchQuery,
    selectedUser,
    selectedUserId,
    setClearConfirmOpen,
    setNewChatOpen,
    setSearchQuery,
    setSelectedUserId,
    usersLoading,
  };
}
