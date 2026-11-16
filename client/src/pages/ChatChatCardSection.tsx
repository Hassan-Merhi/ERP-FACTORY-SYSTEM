// Extracted from ./Chat.tsx to keep that module under the source-size cap.
import { CheckCheck, Download, FileText, MessageCircle, Paperclip, Send, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useChatState } from "./ChatUseChatState";

export function ChatCardSection({
  fileInputRef,
  formatFileSize,
  formatLastSeen,
  formatTime,
  getInitials,
  handleFileSelect,
  handleKeyDown,
  handleSend,
  handleTextChange,
  inputRef,
  isSending,
  isTyping,
  messageText,
  messages,
  messagesEndRef,
  messagesLoading,
  pendingFile,
  removePendingFile,
  selectedUser,
  selectedUserId,
  setClearConfirmOpen,
}: Pick<
  ReturnType<typeof useChatState>,
  | "fileInputRef"
  | "formatFileSize"
  | "formatLastSeen"
  | "formatTime"
  | "getInitials"
  | "handleFileSelect"
  | "handleKeyDown"
  | "handleSend"
  | "handleTextChange"
  | "inputRef"
  | "isSending"
  | "isTyping"
  | "messageText"
  | "messages"
  | "messagesEndRef"
  | "messagesLoading"
  | "pendingFile"
  | "removePendingFile"
  | "selectedUser"
  | "selectedUserId"
  | "setClearConfirmOpen"
>) {
  return (
    <Card className="flex-1 flex flex-col max-md:min-h-0 max-md:w-full max-md:min-w-0 max-md:overflow-hidden">
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
                      {msg.message && <p className="text-sm whitespace-pre-wrap wrap-break-word">{msg.message}</p>}
                      <div className={`flex items-center gap-1 mt-1 ${isMine ? "justify-end" : "justify-start"}`}>
                        <span className={`text-xs ${isMine ? "text-primary-foreground/70" : "text-muted-foreground"}`}>
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
  );
}
