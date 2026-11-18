// Extracted from ./Chat.tsx to keep that module under the source-size cap.

export interface ChatUser {
  id: string;
  username: string;
  active: boolean;
  unreadCount: number;
  hasMessages: boolean;
  isOnline: boolean;
  lastSeen: string | null;
}

export interface PendingFile {
  file: File;
  previewUrl: string | null;
}
