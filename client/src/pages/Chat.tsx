import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Send, MessageCircle, CheckCheck, Plus, Search, Trash2, Paperclip, FileText, X, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { queryClient } from "@/lib/queryClient";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useToast } from "@/hooks/use-toast";
import { subscribeRealtimeChatEvents } from "@/hooks/use-ws-invalidation";
import type { DirectMessage } from "@shared/schema";

interface ChatUser {
  id: string;
  username: string;
  active: boolean;
  unreadCount: number;
  hasMessages: boolean;
  isOnline: boolean;
  lastSeen: string | null;
}

interface PendingFile {
  file: File;
  previewUrl: string | null;
}

export default function Chat() {
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

  const { data: chatUsers = [], isLoading: usersLoading } = useQuery<ChatUser[]>({
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
  const filteredAllUsers = chatUsers.filter((u) => u.username.toLowerCase().includes(searchQuery.toLowerCase()));

  const isSending = sendMutation.isPending || isUploading;

  return (
    <div className="h-[calc(100vh-6rem)] flex gap-3" data-testid="chat-page">
      {/* Left panel: conversations */}
      <Card className="w-64 shrink-0 flex flex-col">
        <div className="p-3 border-b flex items-center justify-between gap-2">
          <h3 className="font-semibold text-sm">Messages</h3>
          <Button size="icon" variant="ghost" onClick={() => setNewChatOpen(true)} data-testid="button-new-chat">
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {usersLoading ? (
            <div className="p-3 space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : conversationUsers.length === 0 ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              No conversations yet.
              <br />
              Click <strong>+</strong> to start one.
            </div>
          ) : (
            conversationUsers.map((user) => (
              <button
                key={user.id}
                className={`w-full flex items-center gap-3 p-3 text-left hover-elevate transition-colors ${selectedUserId === user.id ? "bg-accent" : ""}`}
                onClick={() => setSelectedUserId(user.id)}
                data-testid={`button-chat-user-${user.id}`}
              >
                <div className="relative shrink-0">
                  <Avatar className="h-8 w-8">
                    <AvatarFallback className="text-xs">{getInitials(user.username)}</AvatarFallback>
                  </Avatar>
                  {user.isOnline && (
                    <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-green-500 border-2 border-background" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-sm font-medium truncate">{user.username}</span>
                    {user.unreadCount > 0 && (
                      <Badge variant="default" className="text-xs min-w-5 justify-center">
                        {user.unreadCount}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground truncate">
                    {user.isOnline ? "Online" : user.lastSeen ? formatLastSeen(user) : "Offline"}
                  </p>
                </div>
              </button>
            ))
          )}
        </div>
      </Card>

      {/* Main chat area */}
      <Card className="flex-1 flex flex-col">
        {!selectedUserId ? (
          <CardContent className="flex-1 flex items-center justify-center">
            <div className="text-center text-muted-foreground">
              <MessageCircle className="h-12 w-12 mx-auto mb-3 opacity-50" />
              <p className="text-lg font-medium">Select a conversation</p>
              <p className="text-sm mt-1">Choose from the list or click + to start a new chat</p>
            </div>
          </CardContent>
        ) : (
          <>
            {/* Header */}
            <div className="p-3 border-b flex items-center gap-3">
              <div className="relative shrink-0">
                <Avatar className="h-8 w-8">
                  <AvatarFallback className="text-xs">
                    {selectedUser ? getInitials(selectedUser.username) : "?"}
                  </AvatarFallback>
                </Avatar>
                {selectedUser?.isOnline && (
                  <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-green-500 border-2 border-background" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm leading-tight">{selectedUser?.username}</p>
                {selectedUser && (
                  <p
                    className={`text-xs leading-tight ${isTyping ? "text-muted-foreground italic" : selectedUser.isOnline ? "text-green-500" : "text-muted-foreground"}`}
                  >
                    {isTyping ? "typing..." : formatLastSeen(selectedUser)}
                  </p>
                )}
              </div>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setClearConfirmOpen(true)}
                disabled={messages.length === 0}
                data-testid="button-clear-messages"
                title="Clear conversation"
              >
                <Trash2 className="h-4 w-4 text-muted-foreground" />
              </Button>
            </div>

            {/* Messages area */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {messagesLoading ? (
                <div className="space-y-3">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-10 w-3/4" />
                  ))}
                </div>
              ) : messages.length === 0 ? (
                <div className="text-center text-muted-foreground text-sm py-8">No messages yet. Say hello!</div>
              ) : (
                messages.map((msg) => {
                  const isMine = msg.senderId !== selectedUserId;
                  const isImage = msg.fileType?.startsWith("image/");
                  return (
                    <div
                      key={msg.id}
                      className={`flex ${isMine ? "justify-end" : "justify-start"}`}
                      data-testid={`message-${msg.id}`}
                    >
                      <div
                        className={`max-w-[70%] rounded-lg px-3 py-2 ${
                          isMine ? "bg-primary text-primary-foreground" : "bg-muted"
                        }`}
                      >
                        {msg.fileUrl && (
                          <div className="mb-1">
                            {isImage ? (
                              <a href={msg.fileUrl} target="_blank" rel="noopener noreferrer">
                                <img
                                  src={msg.fileUrl}
                                  alt={msg.fileName ?? "image"}
                                  className="max-w-full rounded-md max-h-64 object-contain"
                                  data-testid={`msg-image-${msg.id}`}
                                />
                              </a>
                            ) : (
                              <a
                                href={msg.fileUrl}
                                download={msg.fileName ?? "file"}
                                className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${isMine ? "bg-primary-foreground/10 hover:bg-primary-foreground/20" : "bg-background/60 hover:bg-background/80"} transition-colors`}
                                data-testid={`msg-file-${msg.id}`}
                              >
                                <FileText className="h-4 w-4 shrink-0" />
                                <span className="truncate max-w-[180px]">{msg.fileName ?? "File"}</span>
                                {msg.fileSize && (
                                  <span
                                    className={`text-xs shrink-0 ${isMine ? "text-primary-foreground/60" : "text-muted-foreground"}`}
                                  >
                                    {formatFileSize(msg.fileSize)}
                                  </span>
                                )}
                                <Download className="h-3 w-3 shrink-0" />
                              </a>
                            )}
                          </div>
                        )}
                        {msg.message && <p className="text-sm whitespace-pre-wrap break-words">{msg.message}</p>}
                        <div className={`flex items-center gap-1 mt-1 ${isMine ? "justify-end" : "justify-start"}`}>
                          <span
                            className={`text-xs ${isMine ? "text-primary-foreground/70" : "text-muted-foreground"}`}
                          >
                            {formatTime(msg.createdAt as unknown as string)}
                          </span>
                          {isMine &&
                            (msg.readAt ? (
                              <span title="Read">
                                <CheckCheck className="h-3 w-3 text-sky-300" />
                              </span>
                            ) : (
                              <span title="Delivered">
                                <CheckCheck className="h-3 w-3 text-primary-foreground/50" />
                              </span>
                            ))}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
              {isTyping && (
                <div className="flex justify-start" data-testid="typing-indicator">
                  <div className="bg-muted rounded-lg px-3 py-2">
                    <div className="flex gap-1 items-center h-4">
                      <span className="h-2 w-2 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:0ms]" />
                      <span className="h-2 w-2 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:150ms]" />
                      <span className="h-2 w-2 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:300ms]" />
                    </div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input area */}
            <div className="p-3 border-t space-y-2">
              {pendingFile && (
                <div className="flex items-center gap-2 p-2 rounded-md bg-muted" data-testid="pending-file-preview">
                  {pendingFile.previewUrl ? (
                    <img
                      src={pendingFile.previewUrl}
                      alt="preview"
                      className="h-12 w-12 object-cover rounded-md shrink-0"
                    />
                  ) : (
                    <div className="h-12 w-12 rounded-md bg-background flex items-center justify-center shrink-0">
                      <FileText className="h-6 w-6 text-muted-foreground" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{pendingFile.file.name}</p>
                    <p className="text-xs text-muted-foreground">{formatFileSize(pendingFile.file.size)}</p>
                  </div>
                  <Button size="icon" variant="ghost" onClick={removePendingFile} data-testid="button-remove-file">
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              )}
              <div className="flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={handleFileSelect}
                  data-testid="input-file-upload"
                />
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isSending}
                  data-testid="button-attach-file"
                  title="Attach file"
                >
                  <Paperclip className="h-4 w-4" />
                </Button>
                <Input
                  ref={inputRef}
                  value={messageText}
                  onChange={handleTextChange}
                  onKeyDown={handleKeyDown}
                  placeholder={pendingFile ? "Add a caption..." : "Type a message..."}
                  disabled={isSending}
                  data-testid="input-chat-message"
                />
                <Button
                  size="icon"
                  onClick={handleSend}
                  disabled={(!messageText.trim() && !pendingFile) || isSending}
                  data-testid="button-send-message"
                >
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>

      {/* Clear messages confirmation dialog */}
      <Dialog open={clearConfirmOpen} onOpenChange={setClearConfirmOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Clear Conversation</DialogTitle>
            <DialogDescription>
              This will permanently delete all messages with <strong>{selectedUser?.username}</strong>. This cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setClearConfirmOpen(false)} data-testid="button-cancel-clear">
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => selectedUserId && clearMutation.mutate(selectedUserId)}
              disabled={clearMutation.isPending}
              data-testid="button-confirm-clear"
            >
              {clearMutation.isPending ? "Clearing..." : "Clear Messages"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New chat dialog */}
      <Dialog open={newChatOpen} onOpenChange={setNewChatOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>New Message</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search users..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
                data-testid="input-user-search"
              />
            </div>
            <div className="max-h-72 overflow-y-auto divide-y rounded-md border">
              {filteredAllUsers.length === 0 ? (
                <div className="p-4 text-center text-sm text-muted-foreground">No users found</div>
              ) : (
                filteredAllUsers.map((user) => (
                  <button
                    key={user.id}
                    className="w-full flex items-center gap-3 p-3 text-left hover-elevate"
                    onClick={() => handleSelectNewUser(user.id)}
                    data-testid={`button-select-user-${user.id}`}
                  >
                    <Avatar className="h-8 w-8">
                      <AvatarFallback className="text-xs">{getInitials(user.username)}</AvatarFallback>
                    </Avatar>
                    <span className="text-sm font-medium">{user.username}</span>
                    {user.unreadCount > 0 && (
                      <Badge variant="default" className="ml-auto text-xs min-w-5 justify-center">
                        {user.unreadCount}
                      </Badge>
                    )}
                  </button>
                ))
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
