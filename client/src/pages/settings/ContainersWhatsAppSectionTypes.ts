// Extracted from ./ContainersWhatsAppSection.tsx

export interface ContainersWaSettings {
  groupChatId: string;
  scheduleEnabled: boolean;
  scheduleHour: number;
  lastSentAt: string | null;
  hasCredentials: boolean;
  waEnabled: boolean;
}

export interface GreenChat {
  id: string;
  name: string;
  type: string;
}
