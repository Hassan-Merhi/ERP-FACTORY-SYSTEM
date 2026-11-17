import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { useChatState } from "./ChatUseChatState";
import { ChatCardSection } from "./ChatChatCardSection";
import { SearchField } from "@/components/ui/search-field";

export default function Chat() {
  const {
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
  } = useChatState();

  return (
    // Below md the conversation list is a bounded pane above the thread, and the thread keeps its
    // own scroll inside the viewport so long histories never push the composer off screen.
    <div
      className="h-[calc(100dvh-6rem)] flex gap-3 max-md:h-[calc(var(--app-viewport-height)-7rem)] max-md:max-h-[calc(var(--app-viewport-height)-7rem)] max-md:min-h-0 max-md:w-full max-md:min-w-0 max-md:flex-col max-md:overflow-hidden"
      data-testid="chat-page"
    >
      {/* Left panel: conversations */}
      <Card className="w-64 shrink-0 flex flex-col max-md:w-full max-md:max-h-[min(36dvh,20rem)] max-md:flex-none">
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
      <ChatCardSection
        fileInputRef={fileInputRef}
        formatFileSize={formatFileSize}
        formatLastSeen={formatLastSeen}
        formatTime={formatTime}
        getInitials={getInitials}
        handleFileSelect={handleFileSelect}
        handleKeyDown={handleKeyDown}
        handleSend={handleSend}
        handleTextChange={handleTextChange}
        inputRef={inputRef}
        isSending={isSending}
        isTyping={isTyping}
        messageText={messageText}
        messages={messages}
        messagesEndRef={messagesEndRef}
        messagesLoading={messagesLoading}
        pendingFile={pendingFile}
        removePendingFile={removePendingFile}
        selectedUser={selectedUser}
        selectedUserId={selectedUserId}
        setClearConfirmOpen={setClearConfirmOpen}
      />

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
            <SearchField
              value={searchQuery}
              onValueChange={setSearchQuery}
              placeholder="Search users..."
              data-testid="input-user-search"
            />
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
